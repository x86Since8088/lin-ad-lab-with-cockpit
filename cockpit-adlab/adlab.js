/* AD Lab — Cockpit dashboard for the samba-ad-lab DC fleet.
 *
 * Models the classic AD consoles against the containerized lab:
 *   Users & Groups  = dsa.msc          Group Policy = gpmc.msc
 *   Sites & Repl    = dssite.msc       DNS          = dnsmgmt.msc
 *   Domain Controllers = promotion/demotion, logs, tracing, RPC, remoting
 *   Clients         = onboarding       Activity     = the API audit plane
 *
 * Navigation is URL-driven via cockpit.location: the tab lives in the path
 * (#/gpo) and an open modal lives in the options (?modal=gpo-edit&target=…),
 * so tabs AND modals are deep-linkable and the browser Back/Forward buttons
 * move through them. cockpit.location.go() is the ONLY way state changes; the
 * router (route()) is the single place that renders from it.
 *
 * ALL privileged work goes through ONE root verb helper
 * (/usr/local/sbin/adlab-admin) via cockpit.spawn with superuser:"require".
 * The helper's `schema` verb returns its verb table and generic forms are
 * built from it; the Group Policy ADMX editor/preferences modals are
 * hand-built on top of the dedicated gpo-* verbs.
 */
(function () {
    "use strict";

    var HELPER = "/usr/local/sbin/adlab-admin";
    var SCHEMA = null;
    var IDENT = null;
    var DOMAINS = [];              // domain-list result (forests), primary first
    var currentDomain = null;      // selected forest realm; null = primary (unscoped)
    // Verbs that must NOT be scoped by the domain selector: lab-wide/meta verbs;
    // the forest-lifecycle verbs (they carry their own --realm, or derive the
    // domain from the DC container label); and the primary-only client verbs.
    var GLOBAL_VERBS = {
        "schema": 1, "version": 1, "config": 1,
        "domain-list": 1, "domain-add": 1, "domain-remove": 1, "domain-backup": 1,
        "dc-decommission": 1,
        "client-list": 1, "client-onboard": 1, "client-remove": 1,
    };
    var currentTab = "overview";
    var lastRenderedTab = null;
    var lastRenderedDomain = null; // forest the body was last rendered for (URL-backed)
    var shownStack = [];           // [{sig, back}] — the open modal backdrops,
                                   // reconciled against the URL modal stack
    var _lastBackdrop = null;      // set by modal() so the reconciler can track it

    // ---------------------------------------------------------------- utils
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }
    function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
    function badge(text, kind) { return el("span", "badge " + (kind || "dim"), text); }

    // ---- contextual help: a "?" on every tab and modal --------------------
    // Set by dispatchModal so a routed modal's inner modal()/transientModal()
    // picks up the right key without every builder passing it.
    var _currentModalHelpKey = null;
    var HELP = {
        overview: { title: "Overview", body: [
            "A live snapshot of the lab: domain identity and functional levels, the seven FSMO role holders, per-DC replication health, SYSVOL status, and every lab container with its state and IP.",
            "Read-only — use the other tabs to act on the directory."] },
        objects: { title: "AD Objects", body: [
            "A dsa.msc-style console: a container/OU tree, a searchable object table (object-type toggles, selectable columns, Advanced Features) and a docked preview with Edit / Attribute Editor / Rename / Delete.",
            "Right-click a tree node or row (or use the ⋯ kebab) for New / Rename / Delete / Properties. The Group Policy Objects folder lists GPOs and both directions of their links.",
            "Reads go to any DC; writes target the PDC emulator, and critical objects are protected from deletion."] },
        spn: { title: "SPNs (Service Principal Names)", body: [
            "Every account that carries a servicePrincipalName, setspn-style. Add / delete SPNs, query which account holds one, and find Kerberos-breaking duplicates.",
            "Add SPN = setspn -S (refuses a duplicate; force = -A); the ✕ = setspn -D; Query = -Q; Find duplicates = -X. Writes land on the PDC emulator."] },
        kerberos: { title: "Kerberos anomaly detection", body: [
            "Detects Kerberoasting: service tickets requested/issued with RC4 (etype 0x17) instead of AES, and accounts pulling many TGS tickets for distinct SPNs in a short window.",
            "Live detection needs KDC auditing on — click “Enable audit” (runtime; resets on a DC restart). The Kerberoast-exposure table (which SPN accounts allow RC4) is always available.",
            "Harden the exposed accounts to AES-only on the Crypto tab."] },
        crypto: { title: "Crypto control plane", body: [
            "Enable or disable encryption per situation. Kerberos account encryption types are set live in the directory; “Bulk harden” applies a preset (e.g. AES-only) across a filter — dry-run first.",
            "Server crypto (SMB / NTLM / LDAP-TLS / schannel) writes smb.conf and reloads; some settings only take effect after a DC restart, and a wrong value can break authentication."] },
        delegation: { title: "Delegation & authentication", body: [
            "Kerberos delegation (S4U) and authentication hardening in one place. The inventory ranks every account with delegation by risk: unconstrained (TRUSTED_FOR_DELEGATION) is highest — a compromise of that host can impersonate any user to any service; DCs hold it by design.",
            "Constrained delegation limits an account to specific service SPNs (msDS-AllowedToDelegateTo); protocol transition (S4U2Proxy) lets it do so for any protocol. Resource-based constrained delegation (RBCD) is set on the TARGET — it names which principals may impersonate to it.",
            "Harden with the Protected Users group (no NTLM/DES/RC4, no delegation, short TGT) and authentication policies / silos (create audit-first; enforcement is by samba's KDC). Writes land on the PDC emulator."] },
        pki: { title: "AD PKI", body: [
            "A domain-integrated public-key infrastructure. The CA node is a dedicated openssl-CA container with its own self-signed Enterprise Root CA — samba is only a certificate consumer, never a CA.",
            "“Publish to AD” writes the root into the forest's Public Key Services tree (Certification Authorities root-trust, AIA for chain-building, NTAuthCertificates to permit smartcard/PKINIT logon, and an Enrollment Service that advertises the CA and its templates), so every domain member trusts it.",
            "Templates are real pKICertificateTemplate objects (seed the standard set or one at a time). Issuance is manual — “Issue certificate” has openssl sign a leaf per the chosen template's policy (key size, EKU, key usage, validity). Directory writes land on the PDC emulator and replicate."] },
        gpo: { title: "Group Policy", body: [
            "Create and edit GPOs. Each GPO is Windows- or Linux-exclusive (the OS column) so a Linux setting never applies on Windows and vice versa; use “set OS” to scope a legacy GPO.",
            "Administrative-Template settings become registry.pol (gpo load); preferences use samba CSEs (gpo manage). The ADMX central store carries both Windows and Linux (Ubuntu/adsys) templates. Writes land on the PDC emulator; SYSVOL replicates within 5 minutes."] },
        sites: { title: "Sites & Replication", body: [
            "AD sites, subnets and site links, and the replication topology and health between the domain controllers."] },
        dns: { title: "DNS", body: [
            "The AD-integrated DNS zones served by the DCs — forward and reverse zones and the records within them."] },
        domains: { title: "Domains (forests)", body: [
            "Each domain is a Samba forest on its own podman network. Add a domain to deploy its first DC; specify a parent to place it on the parent's network and join the parent's forest via a trust (samba has no in-forest child domains).",
            "Per domain: Manage DCs, Back up, Trusts / Create trust, and (non-primary) Remove."] },
        dcs: { title: "Domain Controllers", body: [
            "The DCs of the selected forest: promote an additional DC (replication partner), read a DC's logs, and demote / decommission — never the primary dc1 or a forest's last DC."] },
        clients: { title: "Clients", body: [
            "The lab's member client machines and their domain-join state; onboard the next client here."] },
        members: { title: "Member Servers", body: [
            "Windows member servers via offline domain join (ODJ): provision a machine account and a join blob a stock Windows answer file can consume — no interactive credential on the box."] },
        activity: { title: "Activity", body: [
            "The audit trail: every adlab-admin invocation is appended to a log (never with secret values). This tab is that log."] },
        // routed (non-verb) modals
        "gpo-edit": { title: "Edit GPO", body: [
            "A GPMC-style ADMX policy editor. The GPO's OS scope is detected (and declared if missing) and locks the view to that OS. The left pane is the ADMX category tree — click a folder to list its policies; the count is the policies it holds.",
            "Opening a policy shows its Supported-on and help text, an Enabled / Disabled / Not Configured control, and one control per ADMX element rendered from the template (dropdown, checkbox, number with min/max, free text, list). Save compiles the choice into registry.pol via gpo load; Not Configured removes the policy's values."] },
        "gpo-prefs": { title: "GPO preferences", body: [
            "The samba Unix CSE preferences (sudoers, motd, issue, smb_conf, …) for this GPO — Linux client policy. Filter by OS and subsystem; every CSE is Linux."] },
        "gpo-detail": { title: "GPO settings", body: [
            "A read-only detail of this GPO: metadata, its linked containers, and its registry.pol settings."] },
        "gpo-admx": { title: "ADMX central store", body: [
            "The SYSVOL PolicyDefinitions store, separating Windows from Linux (Ubuntu/adsys) administrative templates — load samba's ADMX, install the generated Ubuntu (adsys) Linux set, or review what is present."] },
        "gpo-templates": { title: "GPO templates", body: [
            "Reusable GPO snapshots: back a GPO up into the template store, stack template settings into a target GPO, or restore a template as a new GPO."] },
        "object-edit": { title: "Edit object", body: [
            "Edit an object's attributes through class-aware tabs (General, Account, …) validated against the live schema. Only changed, writable attributes are sent; read-only / binary / back-link attributes are not editable."] },
        "object-attrs": { title: "Attribute Editor", body: [
            "The raw Attribute Editor: every attribute the object's classes allow, typed from the live schema. Binary / SID / security-descriptor values are shown but not editable here."] }
    };

    function _verbHelp(key) {
        if (!(SCHEMA && SCHEMA.verbs && SCHEMA.verbs[key])) return null;
        var v = SCHEMA.verbs[key], body = [v.help || "No description."];
        if ((v.args || []).length) {
            body.push("Arguments:");
            (v.args || []).forEach(function (a) {
                body.push("• " + a.name + (a.required ? "" : " (optional)") +
                    (a.help ? " — " + a.help : "") +
                    (a.choices ? "  [" + a.choices.join(" | ") + "]" : ""));
            });
        }
        if (v.danger) body.push("⚠ Destructive — double-check before confirming.");
        return { title: key, body: body };
    }
    function helpContent(key) {
        return HELP[key] || _verbHelp(key) ||
            { title: "Help", body: ["No help is available for this view yet."] };
    }
    function helpModal(key) {
        var h = helpContent(key);
        transientModal("Help — " + h.title, function (box, close) {
            (h.body || []).forEach(function (p) {
                box.appendChild(typeof p === "string" ? el("p", "al-help-p", p) : p);
            });
            var ok = el("button", "al-btn", "Close");
            ok.addEventListener("click", close);
            box.appendChild(ok);
        }, false);   // the help modal itself carries no help button
    }
    function helpButton(key, label) {
        var b = el("button", "al-btn secondary al-help", label || "? Help");
        b.type = "button";
        b.setAttribute("aria-label", "Help for this view");
        b.addEventListener("click", function () { helpModal(key); });
        return b;
    }
    function _modalHelpBtn(key) {
        var b = el("button", "al-help-btn", "?");
        b.type = "button"; b.title = "Help"; b.setAttribute("aria-label", "Help");
        b.addEventListener("click", function () { helpModal(key); });
        return b;
    }

    function classify(err) {
        var problem = err && err.problem;
        var msg = (err && (err.message || err.toString())) || "failed";
        if (problem === "access-denied" || problem === "authentication-failed" ||
            problem === "not-authorized" || problem === "cancelled")
            return "Administrative access is required for this action (" + problem + ").";
        if (problem === "not-found")
            return HELPER + " is not installed — run install.sh from cockpit-adlab.";
        return msg;
    }

    /* One verb call. args = {name: value}; stdinData travels on stdin. */
    function run(verb, args, stdinData) {
        var argv = [HELPER];
        // The domain selector scopes every non-global verb onto the chosen
        // forest via the helper's global --domain option (valid before the verb).
        if (currentDomain && !GLOBAL_VERBS[verb]) argv.push("--domain", currentDomain);
        argv.push(verb);
        Object.keys(args || {}).forEach(function (k) {
            if (args[k] !== "" && args[k] !== undefined && args[k] !== null)
                argv.push("--" + k, String(args[k]));
        });
        return new Promise(function (resolve, reject) {
            var proc = cockpit.spawn(argv, { superuser: "require", err: "message" });
            if (stdinData !== undefined) proc.input(stdinData + "\n");
            proc.then(function (out) {
                try {
                    var obj = JSON.parse(out);
                    if (obj && obj.error) reject(obj.error);
                    else resolve(obj);
                } catch (e) { reject("bad JSON from helper: " + String(out).slice(0, 120)); }
            }).catch(function (err, out) {
                try {
                    var obj = JSON.parse(out || "");
                    if (obj && obj.error) return reject(obj.error);
                } catch (e) { /* fall through */ }
                reject(classify(err));
            });
        });
    }

    // ------------------------------------------------------- URL navigation
    /* Navigate: set the tab (path) and optional modal (options). Everything
     * that changes what is on screen goes through here so the URL always
     * reflects state and Back/Forward work. */
    function nav(path, options) {
        cockpit.location.go(path, options || {});
    }
    /* The selected forest lives in the URL (?domain=<realm>) so it is
     * deep-linkable and survives Back/Forward/reload. domOpts() carries it onto
     * every navigation; the primary forest is the absence of the param. */
    function domOpts(extra) {
        var o = {};
        if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
        if (currentDomain) o.domain = currentDomain;
        return o;
    }
    function goTab(tab) { nav([tab], domOpts()); }

    /* The modal STACK lives in the URL as parallel arrays: each open modal is
     * a (modal, target) pair, so the URL reads
     *   #/gpo?modal=gpo-edit&target={GUID}&modal=gpo-detail&target={GUID}
     * and Back/Forward walk the stack one level at a time. `target` carries a
     * special modal's single argument (a GPO GUID); for a generic verb modal
     * it carries the JSON of its presets. */
    function readStack() {
        var o = (cockpit.location && cockpit.location.options) || {};
        var mods = o.modal ? (Array.isArray(o.modal) ? o.modal : [o.modal]) : [];
        var tgts = o.target ? (Array.isArray(o.target) ? o.target : [o.target]) : [];
        return mods.map(function (m, i) { return { modal: m, target: tgts[i] === undefined ? "" : tgts[i] }; });
    }
    function writeStack(stack) {
        if (!stack.length) { nav([currentTab], domOpts()); return; }
        nav([currentTab], domOpts({ modal: stack.map(function (s) { return s.modal; }),
                                    target: stack.map(function (s) { return s.target; }) }));
    }
    /* Push a modal onto the stack (navigates; the router opens it). */
    function openModal(key, extra) {
        extra = extra || {};
        var target = (SCHEMA && SCHEMA.verbs && SCHEMA.verbs[key])
            ? JSON.stringify(extra)                       // verb presets
            : (extra.target !== undefined ? extra.target : "");
        writeStack(readStack().concat([{ modal: key, target: String(target) }]));
    }
    /* Close the TOP modal = pop one level. */
    function closeModal() {
        var s = readStack(); s.pop(); writeStack(s);
    }

    function sigOf(d) { return d.modal + "|" + (d.target || ""); }

    /* The router. Renders the tab body only when the tab changes, then
     * reconciles the visible modal backdrops against the URL stack: shared
     * lower modals are left untouched (their state survives a push on top),
     * only the differing top is closed/opened. */
    function route() {
        var loc = cockpit.location;
        var tab = (loc.path && loc.path[0]) || "overview";
        // #/users was the old "Users & Groups" tab. The objects console (#/objects)
        // replaces it, so redirect rather than let the unknown-tab fallback drop the
        // visitor on Overview: an existing link or bookmark should land on the
        // replacement, not somewhere unrelated. Options are carried across so a
        // deep link keeps any modal it named.
        if (tab === "users") { nav("/objects", loc.options); return; }
        if (!RENDER[tab]) tab = "overview";
        currentTab = tab;
        // The forest scope is URL state: read it back so a deep link / reload /
        // Back-Forward lands on the right forest, and re-render the body when it
        // changes (every scoped verb reads currentDomain when run() builds argv).
        var dom = (loc.options && loc.options.domain) || null;
        currentDomain = dom;          // the URL is the source of truth for the scope
        // Re-render when the tab OR the forest differs from what is ON SCREEN
        // (lastRenderedDomain), NOT from currentDomain — the selector handler
        // pre-sets currentDomain before navigating, so comparing against it would
        // always read "unchanged" and skip the re-render (body/scope desync).
        if (tab !== lastRenderedTab || (dom || "") !== (lastRenderedDomain || "")) {
            lastRenderedTab = tab;
            lastRenderedDomain = dom;
            renderTabs();
            renderDomainSelector();   // keep the header <select> in sync with the URL
            RENDER[tab]();
        }
        reconcileModals(readStack());
    }

    function reconcileModals(urlStack) {
        var c = 0;
        while (c < shownStack.length && c < urlStack.length &&
               shownStack[c].sig === sigOf(urlStack[c])) c++;
        for (var i = shownStack.length - 1; i >= c; i--) {
            var b = shownStack[i].back;
            if (b && b.parentNode) b.parentNode.removeChild(b);
            if (b && b._restore) b._restore();   // return focus to the trigger / parent modal
            shownStack.pop();
        }
        for (var j = c; j < urlStack.length; j++) {
            _lastBackdrop = null;
            dispatchModal(urlStack[j]);
            shownStack.push({ sig: sigOf(urlStack[j]), back: _lastBackdrop });
        }
    }

    function refreshTab() {
        lastRenderedTab = null;   // force a body re-render on next route
        route();
    }

    /* Build the modal named by one stack descriptor. */
    function dispatchModal(desc) {
        var key = desc.modal, target = desc.target;
        _currentModalHelpKey = key;   // routed modals' inner modal() picks this up
        if (SCHEMA && SCHEMA.verbs && SCHEMA.verbs[key]) {
            var presets = {};
            try { presets = JSON.parse(target || "{}"); } catch (e) { presets = {}; }
            verbForm(key, presets);
            return;
        }
        switch (key) {
            case "gpo-edit":      gpoEditModal(target); break;
            case "gpo-admx":      gpoAdmxModal(); break;
            case "gpo-templates": gpoTemplatesModal(); break;
            case "gpo-prefs":     gpoPrefsModal(target); break;
            case "gpo-detail":    gpoDetailModal(target); break;
            case "object-edit":   objectEditModal(target); break;
            case "object-attrs":  objectAttrsModal(target); break;
            default: /* unknown — leave nothing */ break;
        }
    }

    // ------------------------------------------------------------- modal DOM
    /* Dialog a11y for a modal: role/aria, focus into the dialog, Tab-trap, and
     * (for transient modals) Escape-to-close + focus restore. Returns a restore
     * function. closeFn is null for URL-stack modals (Escape is the router's). */
    var _modalTitleSeq = 0;
    function _wireModalA11y(back, box, h2, closeFn) {
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-modal", "true");
        h2.id = "al-mtitle-" + (++_modalTitleSeq);
        box.setAttribute("aria-labelledby", h2.id);
        box.tabIndex = -1;
        var prev = document.activeElement;
        function focusables() {
            return [].slice.call(box.querySelectorAll(
                'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
                'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
                .filter(function (n) { return n.offsetParent !== null; });
        }
        setTimeout(function () { var f = focusables(); (f[0] || box).focus(); }, 0);
        back.addEventListener("keydown", function (ev) {
            if (ev.key === "Tab") {
                var f = focusables(); if (!f.length) { ev.preventDefault(); box.focus(); return; }
                var first = f[0], last = f[f.length - 1], a = document.activeElement;
                if (ev.shiftKey && (a === first || a === box)) { ev.preventDefault(); last.focus(); }
                else if (!ev.shiftKey && a === last) { ev.preventDefault(); first.focus(); }
            } else if (ev.key === "Escape" && closeFn) { ev.preventDefault(); ev.stopPropagation(); closeFn(); }
        });
        return function () { if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* gone */ } } };
    }

    /* Append a modal backdrop onto the stack host (does NOT clear — modals
     * layer). Backdrop click / Escape pop the TOP modal via the URL. */
    function modal(title, bodyBuilder, wide, helpKey) {
        var host = document.getElementById("al-modal-host");
        var back = el("div", "al-backdrop");
        back.style.zIndex = String(50 + host.children.length * 2);
        var box = el("div", "al-modal" + (wide ? " wide" : ""));
        var h2 = el("h2", null, title);
        var head = el("div", "al-modal-head");
        head.appendChild(h2);
        head.appendChild(_modalHelpBtn(helpKey || _currentModalHelpKey || title));
        _currentModalHelpKey = null;
        box.appendChild(head);
        back.addEventListener("click", function (ev) { if (ev.target === back) closeModal(); });
        back.appendChild(box);
        host.appendChild(back);
        _lastBackdrop = back;
        bodyBuilder(box);
        back._restore = _wireModalA11y(back, box, h2, null);   // Escape handled by router; restore on teardown
        return box;
    }

    /* A self-closing overlay NOT tied to the URL stack — for transient result
     * / error popups (e.g. an immediate no-arg verb run). */
    function transientModal(title, bodyBuilder, helpKey) {
        var host = document.getElementById("al-modal-host");
        var back = el("div", "al-backdrop");
        back.style.zIndex = String(400 + host.children.length * 2);
        var box = el("div", "al-modal");
        var h2 = el("h2", null, title);
        if (helpKey === false) {           // the help modal itself: no "?"
            box.appendChild(h2);
        } else {
            var head = el("div", "al-modal-head");
            head.appendChild(h2);
            head.appendChild(_modalHelpBtn(helpKey || _currentModalHelpKey || title));
            box.appendChild(head);
        }
        _currentModalHelpKey = null;
        var restore = null;
        function close() { if (back.parentNode) back.parentNode.removeChild(back); if (restore) restore(); }
        back.addEventListener("click", function (ev) { if (ev.target === back) close(); });
        back.appendChild(box); host.appendChild(back);
        bodyBuilder(box, close);
        restore = _wireModalA11y(back, box, h2, close);   // Escape closes transients
        return { close: close };
    }

    function closeModalDom() { clear(document.getElementById("al-modal-host")); }

    /* Render a verb result INTO an existing modal box (in place), so a form
     * modal becomes its own result view without a second navigation. */
    function fillResult(box, title, res, reRun) {
        clear(box);
        box.appendChild(el("h2", null, title));
        if (res && res.password) {
            var w = el("div", "al-alert warn");
            w.textContent = "Generated password (shown once): ";
            w.appendChild(el("kbd", "al", res.password));
            box.appendChild(w);
        }
        // Preview-then-apply: a dry-run result (commit:false with pending changes,
        // e.g. crypto-harden) reports what WOULD change but applies nothing. Make
        // that explicit and offer a one-click Apply that re-runs with commit=true,
        // so a deep-linked harden modal never looks like it silently did nothing.
        if (reRun && res && res.commit === false && (res.would_change || 0) > 0) {
            var dn = el("div", "al-alert warn");
            dn.textContent = "Dry run — " + res.would_change + " account(s) would change. "
                + "Nothing has been applied yet.";
            box.appendChild(dn);
            var applyBtn = el("button", "al-btn danger",
                "Apply " + res.would_change + " change" + (res.would_change === 1 ? "" : "s") + " now");
            applyBtn.addEventListener("click", function () {
                applyBtn.disabled = true;
                reRun().then(function (r2) { fillResult(box, title, r2); })
                       .catch(function (e) {
                           applyBtn.disabled = false;
                           box.appendChild(el("div", "al-alert err", String(e)));
                       });
            });
            box.appendChild(applyBtn);
        }
        box.appendChild(el("pre", "al-log", JSON.stringify(res, null, 2)));
        var ok = el("button", "al-btn secondary", "Close");
        ok.addEventListener("click", function () { closeModal(); refreshTab(); });
        box.appendChild(ok);
    }

    /* Build a form for a verb straight from the helper's schema. presets
     * pre-fill/hide fields. On success it swaps to the result in place. */
    function verbForm(verb, presets) {
        var spec = SCHEMA.verbs[verb];
        if (!spec) { return; }
        presets = presets || {};
        modal(spec.help.replace(/\.$/, ""), function (box) {
            if (spec.danger)
                box.appendChild(el("div", "danger-note",
                    "Destructive action — double-check before confirming."));
            var form = el("form", "al-form");
            var inputs = {};
            (spec.args || []).forEach(function (a) {
                var lab = el("label", null, a.name + (a.required ? "" : " (optional)"));
                if (a.help) lab.appendChild(el("span", "hint", " — " + a.help));
                // A preset argument (from a deep link's decoded target or the
                // opening context) is shown READ-ONLY and pre-filled, so the modal
                // always presents the decoded data rather than hiding it. It stays
                // out of `inputs`, so submit still takes its value from `presets`.
                // A password (password-stdin) is NEVER honored as a preset: it
                // would show in cleartext and be mis-routed onto argv — always
                // render its own (empty) field, which routes via stdin.
                if ((a.name in presets) && a.type !== "password-stdin") {
                    form.appendChild(lab);
                    var ro = el("input", "al-ro");
                    ro.type = "text";
                    ro.value = String(presets[a.name]);
                    ro.readOnly = true; ro.tabIndex = -1;
                    form.appendChild(ro);
                    return;
                }
                form.appendChild(lab);
                var input;
                if (a.type === "enum") {
                    input = el("select");
                    if (!a.required) input.appendChild(el("option", null, ""));
                    (a.choices || []).forEach(function (c) {
                        var o = el("option", null, c); o.value = c; input.appendChild(o);
                    });
                } else if (a.type === "password-stdin") {
                    input = el("input"); input.type = "password";
                    input.autocomplete = "new-password";
                } else if (a.type === "int") {
                    input = el("input"); input.type = "number";
                    if (a.default !== undefined) input.value = a.default;
                } else {
                    input = el("input"); input.type = "text";
                }
                input.name = a.name;
                form.appendChild(input);
                inputs[a.name] = { spec: a, node: input };
            });
            var needTyped = ["fsmo-seize", "dc-demote", "dc-decommission", "domain-remove",
                             "user-delete", "gpo-delete",
                             "gpo-settings-remove", "client-remove"].indexOf(verb) >= 0;
            var confirmInput = null;
            if (needTyped) {
                var lab2 = el("label", null, "Type the verb name to confirm");
                lab2.appendChild(el("span", "hint", " — " + verb));
                form.appendChild(lab2);
                confirmInput = el("input"); confirmInput.type = "text";
                form.appendChild(confirmInput);
            }
            var alertBox = el("div", "al-alert err");
            form.appendChild(alertBox);
            var rowb = el("div", "row");
            var go = el("button", "al-btn" + (spec.danger ? " danger" : ""), "Run");
            go.type = "submit";
            var cancel = el("button", "al-btn secondary", "Cancel");
            cancel.type = "button";
            cancel.addEventListener("click", closeModal);
            rowb.appendChild(go); rowb.appendChild(cancel);
            form.appendChild(rowb);
            form.addEventListener("submit", function (ev) {
                ev.preventDefault();
                alertBox.textContent = "";
                if (confirmInput && confirmInput.value.trim() !== verb) {
                    alertBox.textContent = 'Type exactly "' + verb + '" to confirm.';
                    return;
                }
                var args = {}, stdinData, bad = null;
                var specByName = {};
                (spec.args || []).forEach(function (x) { specByName[x.name] = x; });
                Object.keys(presets).forEach(function (k) {
                    // A password preset is ignored (it must come from its field via
                    // stdin, never argv) — matches the read-only-render exclusion.
                    if (specByName[k] && specByName[k].type === "password-stdin") return;
                    args[k] = presets[k];
                });
                Object.keys(inputs).forEach(function (k) {
                    var i = inputs[k], v = i.node.value;
                    if (i.spec.type === "password-stdin") {
                        if (v) stdinData = v; else if (i.spec.required) bad = k + " is required";
                        return;
                    }
                    if (!v && i.spec.required) { bad = k + " is required"; return; }
                    if (v) args[k] = v;
                });
                if (bad) { alertBox.textContent = bad; return; }
                go.disabled = true;
                run(verb, args, stdinData).then(function (res) {
                    // reRun re-applies a dry-run verb with commit=true (fillResult
                    // only offers it when the result is an unapplied dry-run).
                    fillResult(box, verb, res, function () {
                        var applyArgs = {}; Object.keys(args).forEach(function (k) { applyArgs[k] = args[k]; });
                        applyArgs.commit = "true";
                        return run(verb, applyArgs, stdinData);
                    });
                }).catch(function (e) {
                    go.disabled = false; alertBox.textContent = String(e);
                });
            });
            box.appendChild(form);
        });
    }

    /* A button that opens a routed modal for a verb (URL-reflected). For a
     * no-argument, non-danger verb it runs immediately and shows the result. */
    function actionButton(label, verb, presets, cls) {
        // destructive verbs get the danger (red) style automatically from the
        // schema, so 'delete'/'unlink'/'demote'/'remove' never look benign.
        if (!cls && SCHEMA && SCHEMA.verbs[verb] && SCHEMA.verbs[verb].danger) cls = "danger";
        var b = el("button", "al-btn " + (cls || "secondary"), label);
        b.addEventListener("click", function () {
            var spec = SCHEMA.verbs[verb];
            var free = (spec.args || []).filter(function (a) {
                return !((a.name in (presets || {})));
            });
            if (free.length === 0 && !spec.danger) {
                b.disabled = true;
                run(verb, presets || {}).then(function (res) {
                    b.disabled = false;
                    transientModal(verb, function (box, close) {
                        if (res && res.password) {
                            var w = el("div", "al-alert warn");
                            w.textContent = "Generated password (shown once): ";
                            w.appendChild(el("kbd", "al", res.password)); box.appendChild(w);
                        }
                        box.appendChild(el("pre", "al-log", JSON.stringify(res, null, 2)));
                        var ok = el("button", "al-btn", "Close");
                        ok.addEventListener("click", function () { close(); refreshTab(); });
                        box.appendChild(ok);
                    });
                }).catch(function (e) {
                    b.disabled = false;
                    transientModal(verb + " failed", function (box, close) {
                        box.appendChild(el("div", "al-alert err", String(e)));
                        var ok = el("button", "al-btn", "Close");
                        ok.addEventListener("click", close);
                        box.appendChild(ok);
                    });
                });
            } else {
                openModal(verb, presets || {});
            }
        });
        return b;
    }

    function tableOf(headers, rows) {
        var wrap = el("div", "al-scroll");
        var t = el("table", "al");
        var tr = el("tr");
        headers.forEach(function (h) { tr.appendChild(el("th", null, h)); });
        t.appendChild(tr);
        rows.forEach(function (cells) {
            var r = el("tr");
            cells.forEach(function (c) {
                var td = el("td");
                if (c instanceof Node) td.appendChild(c);
                else td.textContent = c === undefined || c === null ? "" : String(c);
                r.appendChild(td);
            });
            t.appendChild(r);
        });
        wrap.appendChild(t);
        return wrap;
    }

    function card(title, wide) {
        var c = el("div", "al-card" + (wide ? " wide" : ""));
        if (title) c.appendChild(el("h3", null, title));
        return c;
    }
    function failCard(title, err) {
        var c = card(title);
        c.appendChild(el("div", "al-alert err", String(err)));
        return c;
    }
    /* Reserve a titled card with a loading body at a fixed grid position, then
     * fill its body in place when the data lands — no blank flash, no reflow,
     * deterministic order regardless of which run() resolves first. */
    function slotCard(grid, title, wide) {
        var c = card(title, wide);
        var h3 = c.querySelector("h3");
        var body = el("div"); body.appendChild(el("div", "al-loading", "loading…"));
        c.appendChild(body); grid.appendChild(c);
        // fill(node, newTitle?) — newTitle updates the header (for count-bearing cards)
        return function (node, newTitle) {
            if (newTitle && h3) h3.textContent = newTitle;
            clear(body); if (node) body.appendChild(node);
        };
    }
    function emptyOr(rows, headers, cells, emptyText) {
        return rows.length ? tableOf(headers, rows.map(cells)) : el("div", "hint", emptyText);
    }

    // ---------------------------------------------------------------- tabs
    var TABS = [
        ["overview", "Overview"],
        ["objects", "AD Objects"],
        ["spn", "SPNs"],
        ["kerberos", "Kerberos"],
        ["crypto", "Crypto"],
        ["pki", "PKI"],
        ["delegation", "Delegation"],
        ["gpo", "Group Policy"], ["sites", "Sites & Replication"],
        ["dns", "DNS"], ["domains", "Domains"], ["dcs", "Domain Controllers"],
        ["clients", "Clients"], ["members", "Member Servers"],
        ["activity", "Activity"],
    ];

    function renderTabs() {
        var nav_ = document.getElementById("al-tabs");
        clear(nav_);
        TABS.forEach(function (t) {
            var b = el("button", t[0] === currentTab ? "active" : "", t[1]);
            b.addEventListener("click", function () { goTab(t[0]); });
            nav_.appendChild(b);
        });
    }

    /* The global forest selector: a <select> in the header that scopes every
     * non-global verb (see GLOBAL_VERBS) onto one domain. It only appears once
     * more than one forest exists — a single-domain lab needs no chooser. */
    function renderDomainSelector() {
        var host = document.getElementById("al-conn");
        if (!host) return;
        clear(host);
        if (DOMAINS.length < 2) return;   // nothing to choose between
        host.appendChild(el("span", "al-dom-label", "Forest"));
        var sel = el("select", "al-dom-select");
        DOMAINS.forEach(function (d) {
            // Label shows the forest and, for a parent-linked child, its parent —
            // so subdomains read as such in the chooser.
            var label = d.realm + (d.primary ? " (primary)"
                        : (d.parent ? " ← " + d.parent : ""));
            var o = el("option", null, label);
            o.value = d.primary ? "" : d.realm;   // "" = primary = unscoped
            if ((currentDomain || "") === o.value) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener("change", function () {
            // Update the URL (deep-linkable, Back/Forward-aware); route() re-renders
            // and drops any open modal, whose target may reference the old forest.
            currentDomain = sel.value || null;
            nav([currentTab], domOpts());
        });
        host.appendChild(sel);
    }

    /* Fetch the forest list (always unscoped), keep it, and reconcile the
     * selector. If the selected forest has vanished (e.g. just removed), fall
     * back to the primary so no later verb is scoped onto a dead realm. */
    function loadDomains() {
        return run("domain-list").then(function (r) {
            DOMAINS = (r && r.domains) || [];
            if (currentDomain &&
                !DOMAINS.some(function (d) { return !d.primary && d.realm === currentDomain; })) {
                // The scoped forest is gone (removed/renamed, or a stale deep link).
                // Reset AND scrub it from the URL, otherwise the dead realm keeps
                // coming back on Back/Forward and every scoped verb re-targets it.
                currentDomain = null;
                var o = (cockpit.location && cockpit.location.options) || {};
                if (o.domain) { nav([currentTab], {}); return DOMAINS; }  // route() re-renders on primary
            }
            renderDomainSelector();
            return DOMAINS;
        }).catch(function () { DOMAINS = []; renderDomainSelector(); return DOMAINS; });
    }

    function content() {
        var m = document.getElementById("al-content");
        clear(m);
        var hb = el("div", "al-tabhelp");
        hb.appendChild(helpButton(currentTab));   // per-tab "? Help"
        m.appendChild(hb);
        return m;
    }

    // ------------------------------------------------------------ overview
    function renderOverview() {
        var m = content();
        var grid = el("div", "al-grid"); m.appendChild(grid);
        var fDomain = slotCard(grid, "Domain");
        var fFsmo = slotCard(grid, "FSMO roles");
        var fHealth = slotCard(grid, "Replication health", true);
        var fSysvol = slotCard(grid, "SYSVOL");
        var fContainers = slotCard(grid, "Containers", true);
        function errNode(e) { return el("div", "al-alert err", String(e)); }
        run("domain-info").then(function (r) {
            var info = r.info || {};
            var rows = ["forest", "domain", "netbios_domain", "dc_name", "server_site"]
                .filter(function (k) { return info[k]; })
                .map(function (k) { return [k.replace(/_/g, " "), info[k]]; });
            if (info.levels && info.levels.forest_function_level)
                rows.push(["forest level", info.levels.forest_function_level]);
            fDomain(tableOf(["", ""], rows));
        }).catch(function (e) { fDomain(errNode(e)); });
        run("fsmo-show").then(function (r) {
            fFsmo(tableOf(["role", "holder"], Object.keys(r.roles).sort().map(function (k) {
                return [k.replace("MasterRole", ""), badge(r.roles[k], "ok")];
            })));
        }).catch(function (e) { fFsmo(errNode(e)); });
        run("health").then(function (r) {
            fHealth(tableOf(["DC", "state", "links", "failing links"], r.dcs.map(function (d) {
                return [d.dc, badge(d.state, d.state === "running" ? "ok" : "err"), d.links,
                        d.replication_ok === null ? badge("n/a") :
                            badge(String(d.failures), d.failures === 0 ? "ok" : "err")];
            })));
        }).catch(function (e) { fHealth(errNode(e)); });
        run("sysvol-status").then(function (r) {
            var box = el("div");
            box.appendChild(r.identical
                ? el("div", "al-alert ok", "SYSVOL is byte-identical on every DC.")
                : el("div", "al-alert err", "SYSVOL DIFFERS between DCs — run a sync."));
            box.appendChild(tableOf(["DC", "files", "content hash"],
                r.dcs.map(function (d) { return [d.dc, d.files, d.hash || d.error]; })));
            fSysvol(box);
        }).catch(function (e) { fSysvol(errNode(e)); });
        run("status").then(function (r) {
            fContainers(tableOf(["name", "kind", "ip", "state"], r.containers.map(function (x) {
                return [x.name, x.kind, x.ip, badge(x.state, x.state === "running" ? "ok" : "err")];
            })));
        }).catch(function (e) { fContainers(errNode(e)); });
    }

    // ------------------------------------------------------ users & groups

    // ------------------------------------------- Users & Computers (dsa.msc)
    // A three-pane object console: a container/OU tree on the left, a
    // column-selectable object table in the middle, a docked value/preview
    // pane on the right. Edits open a schema-driven tabbed editor; Advanced
    // opens the full Attribute Editor grid. All forms are built from the live
    // AD schema via the object-schema verb — see docs/aduc-schema.md.

    // The object-type toggles, in display order. Base set is always shown;
    // the "advanced" set appears with Advanced Features (which also reveals
    // system containers in the tree).
    var OBJ_TOGGLES = [
        ["user", "Users"], ["group", "Groups"], ["computer", "Computers"],
        ["contact", "Contacts"], ["organizationalUnit", "OUs"],
    ];
    var OBJ_TOGGLES_ADV = [
        ["container", "Containers"], ["printQueue", "Printers"],
        ["volume", "Shared folders"],
    ];
    var COMMON_COLUMNS = ["sAMAccountName", "userPrincipalName", "displayName",
        "mail", "description", "department", "title", "company",
        "telephoneNumber", "operatingSystem", "dNSHostName", "whenCreated",
        "lastLogonTimestamp"];
    // userAccountControl flags the editor exposes as checkboxes.
    var UAC_FLAGS = [
        [0x00000002, "Account is disabled"],
        [0x00000020, "Password not required"],
        [0x00010000, "Password never expires"],
        [0x00040000, "Smart card is required for interactive logon"],
        [0x00080000, "Trusted for delegation"],
        [0x00100000, "Account is sensitive and cannot be delegated"],
        [0x00400000, "Do not require Kerberos preauthentication"],
    ];

    // A synthetic tree node (not a real directory object): the "Group Policy
    // Objects" folder. Selecting it lists every GPO in the middle pane and its
    // links in the preview — the GPMC "Group Policy Objects" container, in the
    // AD Objects console. The \0 prefix guarantees it never collides with a DN.
    var GPO_NODE = " GPOs";
    var aduc = {
        base: null, classes: null, advanced: false, search: "",
        extraCols: ["description"], selected: null, previewMode: "tabs",
        treeFilter: "", expanded: {}, treeWidth: 300, nodes: [], schemaCache: {},
        gpoSel: null, gpoList: null,   // GPO folder: selected GUID + cached gpo-list
    };
    var aducReload = null;      // set by renderObjects; modals call it after a write

    /* object-schema is ~2.4s (walks the class chain + all attrs + displaySpecs)
     * but a class's schema is invariant, so cache it by structural class — this
     * turns every repeat selection/editor-open from ~2.4s into instant. */
    function getSchema(cls) {
        if (aduc.schemaCache[cls]) return Promise.resolve(aduc.schemaCache[cls]);
        return run("object-schema", { class: cls }).then(function (s) {
            aduc.schemaCache[cls] = s; return s;
        });
    }
    /* object-get (fast) then the cached schema for its class -> [obj, sch]. */
    function getObjectAndSchema(dn, wantProtected) {
        var args = { dn: dn };
        if (wantProtected) args.protected = "yes";
        return run("object-get", args).then(function (obj) {
            return getSchema(obj.structural_class).then(function (sch) { return [obj, sch]; });
        });
    }

    function aducActiveClasses() {
        return Object.keys(aduc.classes).filter(function (k) { return aduc.classes[k]; });
    }
    function dnParent(dn) { return dn.indexOf(",") >= 0 ? dn.slice(dn.indexOf(",") + 1) : ""; }
    function dnRdn(dn) {
        var head = dn.split(",")[0];
        return head.indexOf("=") >= 0 ? head.slice(head.indexOf("=") + 1) : head;
    }

    function renderObjects() {
        if (!aduc.classes) {
            aduc.classes = {};
            OBJ_TOGGLES.forEach(function (t) { aduc.classes[t[0]] = true; });
        }
        var m = content();
        var wrap = el("div", "al-aduc");
        var treePane = el("div", "al-aduc-tree"); treePane.style.width = aduc.treeWidth + "px";
        var split1 = el("div", "al-aduc-split");
        var objPane = el("div", "al-aduc-objects");
        var split2 = el("div", "al-aduc-split");
        var prevPane = el("div", "al-aduc-preview");
        wrap.appendChild(treePane); wrap.appendChild(split1);
        wrap.appendChild(objPane); wrap.appendChild(split2);
        wrap.appendChild(prevPane);
        m.appendChild(wrap);

        // Floor is below the default so the default width is actually reachable by
        // dragging: a 300px default under a 320px floor would snap wider on first drag.
        makeSplitter(split1, treePane, 200, 1000, function (w) { aduc.treeWidth = w; });
        makeSplitter(split2, prevPane, 280, 900, null, true);

        // ---- left: filtered container tree -----------------------------
        var tf = el("input", "al-tree-filter-setting"); tf.type = "search";
        tf.placeholder = "filter tree…"; tf.value = aduc.treeFilter;
        tf.addEventListener("input", function () { aduc.treeFilter = tf.value; drawTree(); });
        treePane.appendChild(tf);
        var treeHost = el("div", "al-aduc-treehost"); treePane.appendChild(treeHost);

        function childrenOf(dn) {
            return aduc.nodes.filter(function (n) { return n.parent === dn; })
                .sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
        }
        function matchDn(dn) {
            var f = aduc.treeFilter.toLowerCase();
            if (!f) return true;
            var node = aduc.byDn[dn];
            if (node && node.name.toLowerCase().indexOf(f) >= 0) return true;
            return childrenOf(dn).some(function (c) { return matchDn(c.dn); });
        }
        function drawNode(dn, depth) {
            var node = aduc.byDn[dn];
            if (!node) return;
            if (aduc.treeFilter && !matchDn(dn)) return;
            var kids = childrenOf(dn);
            var open;
            if (aduc.treeFilter) open = true;              // filtered nodes stay expanded
            else if (aduc.expanded[dn] === undefined) open = depth === 0;  // root open by default
            else open = aduc.expanded[dn];
            var row = el("div", "al-tree-row" + (aduc.base === dn ? " sel" : ""));
            row.style.paddingLeft = (depth * 16 + 6) + "px";
            var tog = el("span", "al-tree-tog", kids.length ? (open ? "▾" : "▸") : "");
            tog.addEventListener("click", function (ev) {
                ev.stopPropagation();
                aduc.expanded[dn] = !open; drawTree();
            });
            row.appendChild(tog);
            var lbl = el("span", "al-tree-label wrap", (node.synthetic ? "🗐 " : "") + node.name);
            if (node.system) lbl.appendChild(badge("sys", "dim"));
            row.appendChild(lbl);
            row.addEventListener("click", function () {
                aduc.base = dn; aduc.selected = null; aduc.gpoSel = null;
                drawTree(); loadList(); drawPreview();
            });
            if (!node.synthetic) {   // real directory objects get the object context menu
                row.addEventListener("contextmenu", function (ev) { ev.preventDefault(); treeNodeMenu(node, ev.clientX, ev.clientY); });
                var tkeb = el("button", "al-kebab", "⋯"); tkeb.type = "button"; tkeb.title = "actions";
                tkeb.addEventListener("click", function (ev) { ev.stopPropagation(); var b = tkeb.getBoundingClientRect(); treeNodeMenu(node, b.right, b.bottom); });
                row.appendChild(tkeb);
            }
            treeHost.appendChild(row);
            if (kids.length && open) kids.forEach(function (c) { drawNode(c.dn, depth + 1); });
        }
        function drawTree() {
            clear(treeHost);
            if (!aduc.nodes.length) { treeHost.appendChild(el("div", "al-loading", "loading tree…")); return; }
            var roots = aduc.nodes.filter(function (n) { return !aduc.byDn[n.parent]; });
            roots.forEach(function (r) { drawNode(r.dn, 0); });
        }
        function loadTree() {
            treeHost.appendChild(el("div", "al-loading", "loading tree…"));
            run("object-tree", { system: aduc.advanced ? "yes" : "" }).then(function (r) {
                aduc.nodes = r.nodes || [];
                // Append the synthetic "Group Policy Objects" folder as a root
                // sibling of the domain. parent is a sentinel absent from byDn,
                // so drawTree() treats it as a root; it has no real children.
                aduc.nodes.push({ dn: GPO_NODE, parent: " root",
                                  name: "Group Policy Objects", class: "gpoFolder", synthetic: true });
                aduc.byDn = {}; aduc.nodes.forEach(function (n) { aduc.byDn[n.dn] = n; });
                aduc.rootBase = r.base;   // the domain root DN (its children are the tree roots)
                if (!aduc.base || !aduc.byDn[aduc.base]) aduc.base = r.base;
                drawTree(); loadList();
            }).catch(function (e) { clear(treeHost); treeHost.appendChild(el("div", "al-alert err", String(e))); });
        }

        // ---- middle: toolbar + object table ----------------------------
        var toolbar = el("div", "al-obj-toolbar");
        var searchIn = el("input", "al-obj-search"); searchIn.type = "search";
        searchIn.placeholder = "search this container…"; searchIn.value = aduc.search;
        var searchT;
        searchIn.addEventListener("input", function () {
            aduc.search = searchIn.value; clearTimeout(searchT); searchT = setTimeout(loadList, 250);
        });
        toolbar.appendChild(searchIn);
        var chipRow = el("div", "al-obj-chips");
        function drawChips() {
            clear(chipRow);
            OBJ_TOGGLES.concat(aduc.advanced ? OBJ_TOGGLES_ADV : []).forEach(function (t) {
                var on = !!aduc.classes[t[0]];
                var b = el("button", "al-chip" + (on ? " on" : ""), t[1]); b.type = "button";
                b.addEventListener("click", function () { aduc.classes[t[0]] = !on; loadList(); });
                chipRow.appendChild(b);
            });
            var adv = el("button", "al-chip" + (aduc.advanced ? " on" : ""), "Advanced Features"); adv.type = "button";
            adv.addEventListener("click", function () {
                aduc.advanced = !aduc.advanced;
                if (aduc.advanced) OBJ_TOGGLES_ADV.forEach(function (t) { if (!(t[0] in aduc.classes)) aduc.classes[t[0]] = false; });
                drawChips(); loadTree();
            });
            chipRow.appendChild(adv);
        }
        toolbar.appendChild(chipRow);
        drawChips();
        var colsBtn = el("button", "al-btn secondary", "Columns…");
        colsBtn.addEventListener("click", columnPicker);
        var refreshBtn = el("button", "al-btn secondary", "⟳ Refresh");
        refreshBtn.addEventListener("click", function () { loadTree(); drawPreview(); });
        toolbar.appendChild(colsBtn); toolbar.appendChild(refreshBtn);
        objPane.appendChild(toolbar);

        var tableWrap = el("div", "al-objtable-wrap");
        var summary = el("div", "al-objtable-summary", "");
        objPane.appendChild(tableWrap); objPane.appendChild(summary);

        function columns() { return ["name", "class"].concat(aduc.extraCols); }
        function loadList() {
            if (aduc.base === GPO_NODE) { loadGpoList(); return; }
            if (!aduc.base) { clear(tableWrap); tableWrap.appendChild(el("div", "hint", "select a container in the tree")); summary.textContent = ""; return; }
            clear(tableWrap); tableWrap.appendChild(el("div", "al-loading", "listing objects…"));
            var classes = aducActiveClasses();
            run("object-list", {
                base: aduc.base, scope: "one", classes: classes.join(","),
                search: aduc.search, attrs: aduc.extraCols.join(","),
            }).then(function (r) {
                clear(tableWrap);
                var t = el("table", "al al-objtable");
                var hr = el("tr");
                columns().forEach(function (c) { hr.appendChild(el("th", null, c)); });
                hr.appendChild(el("th", "al-kebhdr", ""));
                t.appendChild(hr);
                (r.objects || []).forEach(function (o) {
                    var tr = el("tr", aduc.selected === o.dn ? "sel" : "");
                    columns().forEach(function (c) {
                        var v = c === "name" ? o.name : c === "class" ? o.class : (o.attrs[c] || "");
                        tr.appendChild(el("td", null, v));
                    });
                    tr.addEventListener("click", function () {
                        aduc.selected = o.dn; aduc.selectedName = o.name; aduc.selectedClass = o.class;
                        aduc.selectedSam = (o.attrs && o.attrs.sAMAccountName) || o.name;
                        [].forEach.call(t.querySelectorAll("tr.sel"), function (x) { x.className = ""; });
                        tr.className = "sel"; drawPreview();
                    });
                    tr.addEventListener("dblclick", function () { openModal("object-edit", { target: o.dn }); });
                    function selectRow() {
                        aduc.selected = o.dn; aduc.selectedName = o.name; aduc.selectedClass = o.class;
                        aduc.selectedSam = (o.attrs && o.attrs.sAMAccountName) || o.name;
                        [].forEach.call(t.querySelectorAll("tr.sel"), function (x) { x.className = ""; });
                        tr.className = "sel"; drawPreview();
                    }
                    tr.addEventListener("contextmenu", function (ev) { ev.preventDefault(); selectRow(); objectRowMenu(o, ev.clientX, ev.clientY); });
                    var kcell = el("td", "al-kebcell");
                    var rkeb = el("button", "al-kebab", "⋯"); rkeb.type = "button"; rkeb.title = "actions";
                    rkeb.addEventListener("click", function (ev) { ev.stopPropagation(); selectRow(); var b = rkeb.getBoundingClientRect(); objectRowMenu(o, b.right, b.bottom); });
                    kcell.appendChild(rkeb); tr.appendChild(kcell);
                    t.appendChild(tr);
                });
                tableWrap.appendChild(t);
                summary.textContent = r.count + " object" + (r.count === 1 ? "" : "s") +
                    (r.truncated ? " (truncated)" : "") + " · " + dnRdn(aduc.base);
            }).catch(function (e) { clear(tableWrap); tableWrap.appendChild(el("div", "al-alert err", String(e))); });
        }
        aducReload = function () { loadList(); drawPreview(); };
        aducSelect = function (dn) {   // jump the preview to a referenced object
            aduc.selected = dn; aduc.selectedName = dnRdn(dn); aduc.selectedSam = null; drawPreview();
        };

        // ---- GPOs folder: list + preview + links ----------------------
        function gpoDisplayName(guid) {
            var list = aduc.gpoList || [], u = String(guid).toUpperCase();
            for (var i = 0; i < list.length; i++)
                if (String(list[i].gpo).toUpperCase() === u) return list[i].display_name || guid;
            return guid;
        }
        function matchGpoGuid(guid) {   // the exact gpo-list key matching a gPLink GUID (for row highlight)
            var list = aduc.gpoList || [], u = String(guid).toUpperCase();
            for (var i = 0; i < list.length; i++)
                if (String(list[i].gpo).toUpperCase() === u) return list[i].gpo;
            return guid;
        }
        function withGpoNames(cb) {   // ensure aduc.gpoList is populated, then run cb (best-effort)
            if (aduc.gpoList) { cb(); return; }
            run("gpo-list").then(function (r) { aduc.gpoList = r.gpos || []; cb(); }).catch(function () { cb(); });
        }
        // A container's gPLink -> [{dn, guid, disabled, enforced}] (order as stored).
        function parseGplink(raw) {
            var s = Array.isArray(raw) ? raw.join("") : (raw || "");
            var out = [], re = /\[LDAP:\/\/(CN=\{[0-9A-Fa-f-]+\}[^;]*);(\d+)\]/g, m;
            while ((m = re.exec(s))) {
                var dn = m[1], opt = parseInt(m[2], 10) || 0, gm = /\{[0-9A-Fa-f-]+\}/.exec(dn);
                out.push({ dn: dn, guid: gm ? gm[0] : dn, disabled: !!(opt & 1), enforced: !!(opt & 2) });
            }
            return out;
        }
        function gotoContainer(dn) {   // jump from a GPO's link list to that container in the tree
            if (aduc.byDn[dn] || dn === aduc.rootBase) { aduc.base = dn; aduc.selected = null; aduc.gpoSel = null; drawTree(); loadList(); drawPreview(); }
            else transientModal("Linked container", function (b) {
                b.appendChild(el("div", "hint", "This container is outside the object tree:"));
                b.appendChild(el("kbd", "al", dn));
            });
        }
        function gpoRowMenu(g, x, y) {
            contextMenu(x, y, [
                { label: "Edit settings…", onClick: function () { openModal("gpo-edit", { target: g.gpo }); } },
                { label: "Details…", onClick: function () { openModal("gpo-detail", { target: g.gpo }); } },
                { label: "Preferences…", onClick: function () { openModal("gpo-prefs", { target: g.gpo }); } },
                { sep: true },
                { label: "Link to a container…", onClick: function () { openModal("gpo-link", { gpo: g.gpo }); } },
                { label: "Refresh", onClick: function () { loadGpoList(); } },
            ]);
        }
        function loadGpoList() {
            clear(tableWrap); tableWrap.appendChild(el("div", "al-loading", "listing GPOs…"));
            summary.textContent = "";
            run("gpo-list").then(function (r) {
                aduc.gpoList = r.gpos || [];
                clear(tableWrap);
                var t = el("table", "al al-objtable");
                var hr = el("tr");
                ["name", "version", "GUID"].forEach(function (c) { hr.appendChild(el("th", null, c)); });
                hr.appendChild(el("th", "al-kebhdr", ""));
                t.appendChild(hr);
                aduc.gpoList.forEach(function (g) {
                    var tr = el("tr", (aduc.gpoSel === g.gpo) ? "sel" : "");
                    tr.appendChild(el("td", null, g.display_name || "(unnamed)"));
                    tr.appendChild(el("td", null, g.version || ""));
                    tr.appendChild(el("td", "al-gpo-guid", g.gpo));
                    function selectRow() {
                        aduc.gpoSel = g.gpo; aduc.selected = null;
                        [].forEach.call(t.querySelectorAll("tr.sel"), function (x) { x.className = ""; });
                        tr.className = "sel"; drawPreview();
                    }
                    tr.addEventListener("click", selectRow);
                    tr.addEventListener("dblclick", function () { openModal("gpo-edit", { target: g.gpo }); });
                    tr.addEventListener("contextmenu", function (ev) { ev.preventDefault(); selectRow(); gpoRowMenu(g, ev.clientX, ev.clientY); });
                    var kcell = el("td", "al-kebcell");
                    var rkeb = el("button", "al-kebab", "⋯"); rkeb.type = "button"; rkeb.title = "actions";
                    rkeb.addEventListener("click", function (ev) { ev.stopPropagation(); selectRow(); var b = rkeb.getBoundingClientRect(); gpoRowMenu(g, b.right, b.bottom); });
                    kcell.appendChild(rkeb); tr.appendChild(kcell);
                    t.appendChild(tr);
                });
                tableWrap.appendChild(t);
                summary.textContent = aduc.gpoList.length + " GPO" + (aduc.gpoList.length === 1 ? "" : "s") +
                    (r.pdc_emulator ? " · " + r.pdc_emulator : "");
            }).catch(function (e) { clear(tableWrap); tableWrap.appendChild(el("div", "al-alert err", String(e))); });
        }
        function drawGpoPreview() {
            clear(prevPane);
            var hdr = el("div", "al-prev-hdr");
            hdr.appendChild(el("div", "al-prev-title", aduc.gpoSel ? gpoDisplayName(aduc.gpoSel) : "Group Policy Objects"));
            prevPane.appendChild(hdr);
            var actbar = el("div", "al-prev-actions");
            function abtn(label, cls, fn, dis) { var b = el("button", "al-btn " + (cls || "secondary"), label); if (dis) b.disabled = true; else b.addEventListener("click", fn); actbar.appendChild(b); return b; }
            var g = aduc.gpoSel;
            abtn("Edit settings", "", function () { openModal("gpo-edit", { target: g }); }, !g);
            abtn("Details", "secondary", function () { openModal("gpo-detail", { target: g }); }, !g);
            abtn("Link…", "secondary", function () { openModal("gpo-link", { gpo: g }); }, !g);
            abtn("⟳", "secondary", function () { drawPreview(); }, !g);
            prevPane.appendChild(actbar);
            var body = el("div", "al-prev-body"); prevPane.appendChild(body);
            if (!g) { body.appendChild(el("div", "hint", "select a GPO to see its links and settings")); return; }
            body.appendChild(el("div", "al-loading", "loading…"));
            run("gpo-show", { gpo: g }).then(function (r) {
                clear(body);
                var meta = r.meta || {}, metaRows = [];
                if (meta.display_name) metaRows.push(["display name", meta.display_name]);
                metaRows.push(["GUID", g]);
                if (meta.path) metaRows.push(["path", meta.path]);
                if (meta.version) metaRows.push(["version", meta.version]);
                metaRows.push(["registry settings", String((r.settings || []).length)]);
                var secM = el("div", "al-prev-sec"); secM.appendChild(el("h4", null, "GPO"));
                secM.appendChild(tableOf(["", ""], metaRows)); body.appendChild(secM);
                var lk = r.links || [];
                var secL = el("div", "al-prev-sec"); secL.appendChild(el("h4", null, "Links (" + lk.length + ")"));
                if (!lk.length) secL.appendChild(el("div", "hint", "not linked to any container"));
                else {
                    var box = el("div", "al-valcell");
                    lk.forEach(function (dn) {
                        var a = el("a", "al-dnval al-dnlink", dn); a.href = "#"; a.title = "go to " + dn;
                        a.addEventListener("click", function (ev) { ev.preventDefault(); gotoContainer(dn); });
                        box.appendChild(a);
                    });
                    secL.appendChild(box);
                }
                body.appendChild(secL);
            }).catch(function (e) { clear(body); body.appendChild(el("div", "al-alert err", String(e))); });
        }

        // ---- context-menu actions (tree nodes + object rows) ----------
        var NEW_CLASSES = [["organizationalUnit", "Organizational Unit"], ["user", "User"],
            ["group", "Group"], ["computer", "Computer"], ["contact", "Contact"]];
        function actRun(verb, args) {
            run(verb, args).then(function () { if (aducReload) aducReload(); })
                .catch(function (e) { transientModal("Error", function (b) { b.appendChild(el("div", "al-alert err", String(e))); }); });
        }
        function createFlow(cls, parentDn) {
            var labels = {}; NEW_CLASSES.forEach(function (c) { labels[c[0]] = c[1]; });
            transientModal("New " + labels[cls], function (box) {
                box.appendChild(el("div", "hint", "in: ")).appendChild(el("kbd", "al", dnRdn(parentDn)));
                var name = el("input", "al-in"); name.type = "text";
                name.placeholder = cls === "user" ? "logon name (sAMAccountName)" : cls === "organizationalUnit" ? "OU name" : "name";
                box.appendChild(el("label", null, "Name")); box.appendChild(name);
                var given, surname;
                if (cls === "user" || cls === "contact") {
                    given = el("input", "al-in"); given.type = "text";
                    surname = el("input", "al-in"); surname.type = "text";
                    box.appendChild(el("label", null, "Given name")); box.appendChild(given);
                    box.appendChild(el("label", null, "Surname")); box.appendChild(surname);
                }
                var desc = el("input", "al-in"); desc.type = "text";
                box.appendChild(el("label", null, "Description")); box.appendChild(desc);
                var msg = el("div", "hint", "");
                var ok = el("button", "al-btn", "Create");
                ok.addEventListener("click", function () {
                    var n = name.value.trim(); if (!n) { msg.textContent = "name is required"; return; }
                    var args = { class: cls, name: n, parent: parentDn };
                    if (given && given.value.trim()) args.given = given.value.trim();
                    if (surname && surname.value.trim()) args.surname = surname.value.trim();
                    if (desc.value.trim()) args.description = desc.value.trim();
                    ok.disabled = true; msg.textContent = "creating…";
                    run("object-create", args).then(function (r) {
                        clear(msg);
                        var done = el("div", "al-alert ok"); done.textContent = "Created " + n + ".";
                        if (r.password) { done.appendChild(el("span", null, " One-time password: ")); done.appendChild(el("kbd", "al", r.password)); }
                        msg.appendChild(done);
                        aduc.base = parentDn; loadTree(); if (aducReload) aducReload();
                        name.value = ""; if (given) given.value = ""; if (surname) surname.value = ""; desc.value = "";
                        ok.disabled = false; ok.textContent = "Create another";
                    }).catch(function (e) { ok.disabled = false; msg.textContent = String(e); });
                });
                box.appendChild(ok); box.appendChild(msg);
            });
        }
        function treeNodeMenu(node, x, y) {
            var dn = node.dn, isOU = node.class === "organizationalUnit", isRoot = !aduc.byDn[node.parent];
            contextMenu(x, y, [
                { label: "New", submenu: NEW_CLASSES.map(function (c) { return { label: c[1], onClick: function () { createFlow(c[0], dn); } }; }) },
                { sep: true },
                { label: "Rename…", disabled: !isOU, onClick: function () { renamePrompt(dn); } },
                { label: "Delete…", danger: true, disabled: isRoot, onClick: function () { deletePrompt(dn); } },
                { label: "Deletion protection…", disabled: isRoot, onClick: function () { protectPrompt(dn); } },
                { sep: true },
                { label: "Link a GPO…", onClick: function () { gpoLinkPrompt(dn); } },
                { label: "Refresh", onClick: function () { loadTree(); } },
                { label: "Properties…", onClick: function () { openModal("object-edit", { target: dn }); } },
            ]);
        }
        function objectRowMenu(o, x, y) {
            var dn = o.dn;
            var items = [
                { label: "Edit…", onClick: function () { openModal("object-edit", { target: dn }); } },
                { label: "Attribute Editor…", onClick: function () { openModal("object-attrs", { target: dn }); } },
                { sep: true },
                { label: "Rename / Move…", onClick: function () { renamePrompt(dn); } },
                { label: "Delete…", danger: true, onClick: function () { deletePrompt(dn); } },
                { label: "Deletion protection…", onClick: function () { protectPrompt(dn); } },
            ];
            if (o.class === "user") {
                var sam = (o.attrs && o.attrs.sAMAccountName) || o.name;
                items.push({ sep: true });
                items.push({ label: "Add to a group…", onClick: function () { addToGroupPrompt(sam); } });
                items.push({ label: "Enable account", onClick: function () { actRun("user-enable", { name: sam }); } });
                items.push({ label: "Disable account", onClick: function () { actRun("user-disable", { name: sam }); } });
                items.push({ label: "Reset password…", onClick: function () { openModal("user-setpassword", { name: sam }); } });
            }
            contextMenu(x, y, items);
        }
        renderObjects._treeMenu = treeNodeMenu; renderObjects._rowMenu = objectRowMenu;

        function columnPicker() {
            transientModal("Columns", function (box, close) {
                var chosen = {}; aduc.extraCols.forEach(function (c) { chosen[c] = true; });
                var host = el("div", "al-facet-row"); host.style.flexWrap = "wrap";
                COMMON_COLUMNS.forEach(function (c) {
                    var b = el("button", "al-chip" + (chosen[c] ? " on" : ""), c); b.type = "button";
                    b.addEventListener("click", function () { if (chosen[c]) delete chosen[c]; else chosen[c] = true; b.className = "al-chip" + (chosen[c] ? " on" : ""); });
                    host.appendChild(b);
                });
                box.appendChild(host);
                var ok = el("button", "al-btn", "Apply");
                ok.addEventListener("click", function () {
                    aduc.extraCols = COMMON_COLUMNS.filter(function (c) { return chosen[c]; });
                    if (!aduc.extraCols.length) aduc.extraCols = ["description"];
                    close(); loadList();
                });
                box.appendChild(ok);
            });
        }

        // ---- right: docked preview + actions ---------------------------
        function drawPreview() {
            if (aduc.base === GPO_NODE) { drawGpoPreview(); return; }
            clear(prevPane);
            var hdr = el("div", "al-prev-hdr");
            var title = el("div", "al-prev-title", aduc.selected ? aduc.selectedName : "No selection");
            hdr.appendChild(title);
            prevPane.appendChild(hdr);
            var actbar = el("div", "al-prev-actions");
            function abtn(label, cls, fn, dis) {
                var b = el("button", "al-btn " + (cls || "secondary"), label);
                if (dis) b.disabled = true; else b.addEventListener("click", fn);
                actbar.appendChild(b); return b;
            }
            var dn = aduc.selected;
            abtn("Edit", "", function () { openModal("object-edit", { target: dn }); }, !dn);
            abtn("Advanced", "secondary", function () { openModal("object-attrs", { target: dn }); }, !dn);
            abtn("Rename", "secondary", function () { renamePrompt(dn); }, !dn);
            abtn("Delete", "danger", function () { deletePrompt(dn); }, !dn);
            abtn("Other ▾", "secondary", function (ev) { otherMenu(dn, ev); }, !dn);
            abtn("⟳", "secondary", function () { drawPreview(); }, !dn);
            prevPane.appendChild(actbar);

            var modeRow = el("div", "al-prev-mode");
            ["tabs", "list"].forEach(function (mode) {
                var b = el("button", "al-chip" + (aduc.previewMode === mode ? " on" : ""), mode === "tabs" ? "Tabbed" : "List"); b.type = "button";
                b.addEventListener("click", function () { aduc.previewMode = mode; drawPreview(); });
                modeRow.appendChild(b);
            });
            prevPane.appendChild(modeRow);

            var body = el("div", "al-prev-body"); prevPane.appendChild(body);
            if (!dn) { body.appendChild(el("div", "hint", "select an object to preview its values")); return; }
            body.appendChild(el("div", "al-loading", "loading…"));
            getObjectAndSchema(dn, true).then(function (res) {
                var obj = res[0], sch = res[1];
                clear(body);
                var hl = el("div", "hint", sch.class_label + " · "); hl.appendChild(el("kbd", "al", dn));
                if (obj.protected) hl.appendChild(el("span", "al-tag", "🔒 protected"));
                body.appendChild(hl);
                if (aduc.previewMode === "tabs") {
                    sch.tabs.forEach(function (tab) {
                        var sec = el("div", "al-prev-sec");
                        sec.appendChild(el("h4", null, tab.label));
                        var rows = tab.fields.map(function (f) {
                            return [f.label, formatValue(f, obj.attrs[f.attr] || [])];
                        });
                        sec.appendChild(tableOf(["", ""], rows));
                        body.appendChild(sec);
                    });
                } else {
                    var names = Object.keys(obj.attrs).sort();
                    body.appendChild(tableOf(["attribute", "value"], names.map(function (n) {
                        return [n, formatValue({ attr: n, multi: obj.attrs[n].length > 1 }, obj.attrs[n])];
                    })));
                }
                // Linked GPOs: parse this container's gPLink so the OU/domain
                // side of the link is viewable too (names resolved, enforced/
                // disabled flagged, click jumps to the GPO in the GPOs folder).
                if (obj.attrs && obj.attrs.gPLink) {
                    var glinks = parseGplink(obj.attrs.gPLink);
                    if (glinks.length) {
                        var secG = el("div", "al-prev-sec");
                        secG.appendChild(el("h4", null, "Linked GPOs (" + glinks.length + ")"));
                        var holder = el("div"); secG.appendChild(holder); body.appendChild(secG);
                        withGpoNames(function () {
                            clear(holder);
                            var box = el("div", "al-valcell");
                            glinks.forEach(function (lki) {
                                var line = el("div", "al-gpolink");
                                var a = el("a", "al-dnlink", gpoDisplayName(lki.guid)); a.href = "#";
                                a.title = "open " + lki.guid;
                                a.addEventListener("click", function (ev) {
                                    ev.preventDefault();
                                    aduc.base = GPO_NODE; aduc.gpoSel = matchGpoGuid(lki.guid); aduc.selected = null;
                                    drawTree(); loadList(); drawPreview();
                                });
                                line.appendChild(a);
                                if (lki.enforced) line.appendChild(badge("enforced", "warn"));
                                if (lki.disabled) line.appendChild(badge("disabled", "dim"));
                                box.appendChild(line);
                            });
                            holder.appendChild(box);
                        });
                    }
                }
                // SPNs: shown for ANY account that carries them (users too, not
                // just the computer form's Delegation tab). Manage on the SPN tab.
                if (obj.attrs && obj.attrs.servicePrincipalName && obj.attrs.servicePrincipalName.length) {
                    var spns = obj.attrs.servicePrincipalName.slice().sort();
                    var secS = el("div", "al-prev-sec");
                    secS.appendChild(el("h4", null, "SPNs (" + spns.length + ")"));
                    var boxS = el("div", "al-spnlist");
                    spns.forEach(function (s) {
                        var line = el("div", "al-spnrow");
                        line.appendChild(el("code", "al-spn", s));
                        boxS.appendChild(line);
                    });
                    secS.appendChild(boxS);
                    var manage = el("button", "al-btn secondary", "Manage SPNs →");
                    manage.addEventListener("click", function () { goTab("spn"); });
                    secS.appendChild(manage);
                    body.appendChild(secS);
                }
            }).catch(function (e) { clear(body); body.appendChild(el("div", "al-alert err", String(e))); });
        }

        loadTree();
        drawPreview();
    }

    function formatValue(field, values) {
        if (!values || !values.length) return el("span", "hint", "‹not set›");
        var box = el("div", "al-valcell");
        values.slice(0, 40).forEach(function (v) {
            var line = String(v);
            if (field.type === "dn" || /^(CN|OU|DC)=/.test(line)) {
                // clickable: jump to the referenced object (group, manager, member…)
                var a = el("a", "al-dnval al-dnlink", line); a.href = "#"; a.title = "open " + line;
                a.addEventListener("click", function (ev) {
                    ev.preventDefault();
                    if (aducSelect) aducSelect(line); else openModal("object-edit", { target: line });
                });
                box.appendChild(a);
            } else { box.appendChild(el("div", null, line)); }
        });
        if (values.length > 40) box.appendChild(el("div", "hint", "+" + (values.length - 40) + " more"));
        return box;
    }

    // ---- field editors (type-driven, from the schema) ------------------
    function decodeUac(intVal) {
        var n = parseInt(intVal, 10) || 0, on = {};
        UAC_FLAGS.forEach(function (f) { if (n & f[0]) on[f[0]] = true; });
        return { n: n, on: on };
    }
    function fieldEditor(field, values) {
        var type = field.type || "text";
        var multi = field.multi;
        if (field.readonly || type === "binary" || type === "sid" || type === "ntsd") {
            var ro = el("div", "al-ro"); ro.appendChild(formatValue(field, values));
            ro.appendChild(el("span", "al-tag", "read-only"));
            return { node: ro, get: function () { return values; }, readonly: true };
        }
        if (field.kind === "uac") {
            var st = decodeUac(values[0] || "0");
            var host = el("div", "al-uac");
            var checks = [];
            UAC_FLAGS.forEach(function (f) {
                var id = "uac-" + f[0];
                var lab = el("label", "al-check");
                var cb = el("input"); cb.type = "checkbox"; cb.checked = !!st.on[f[0]];
                lab.appendChild(cb); lab.appendChild(el("span", null, " " + f[1]));
                host.appendChild(lab); checks.push([f[0], cb]);
            });
            return { node: host, get: function () {
                var n = st.n;
                checks.forEach(function (c) { if (c[1].checked) n |= c[0]; else n &= ~c[0]; });
                return [String(n >>> 0)];
            } };
        }
        if (field.kind === "grouptype") {
            var g = parseInt(values[0] || "0", 10) || 0;
            var scope = (g & 0x2) ? "Global" : (g & 0x4) ? "Domain local" : (g & 0x8) ? "Universal" : "?";
            var sec = (g & 0x80000000) ? "Security" : "Distribution";
            var d = el("div", "al-ro"); d.textContent = sec + " · " + scope + " (" + g + ")";
            d.appendChild(el("span", "al-tag", "edit raw in Advanced"));
            return { node: d, get: function () { return values; }, readonly: true };
        }
        if (type === "bool") {
            var sel = el("select");
            [["", "‹not set›"], ["TRUE", "TRUE"], ["FALSE", "FALSE"]].forEach(function (o) {
                var op = el("option", null, o[1]); op.value = o[0]; if ((values[0] || "") === o[0]) op.selected = true; sel.appendChild(op);
            });
            return { node: sel, get: function () { return sel.value ? [sel.value] : []; } };
        }
        if (multi || type === "multitext") {
            var ta = el("textarea", "al-ta"); ta.rows = Math.min(8, Math.max(2, values.length + 1));
            ta.value = values.join("\n");
            ta.placeholder = multi ? "one value per line" : "";
            return { node: ta, get: function () {
                return ta.value.split("\n").map(function (s) { return s.replace(/\r$/, ""); })
                    .filter(function (s) { return s.length; });
            } };
        }
        var inp = el("input", "al-in"); inp.type = "text"; inp.value = values[0] || "";
        if (type === "int" || type === "int64") inp.inputMode = "numeric";
        if (field.maxlen) inp.maxLength = field.maxlen;
        if (type === "time") inp.placeholder = "AD time (raw)";
        return { node: inp, get: function () { return inp.value.trim() ? [inp.value.trim()] : []; } };
    }

    function sameVals(a, b) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    // ---- schema-driven tabbed object editor ----------------------------
    function objectEditModal(dn) {
        if (!dn) { return; }
        modal("Edit object", function (box) {
            box.appendChild(el("div", "hint", "")).appendChild(el("kbd", "al", dn));
            var host = el("div"); box.appendChild(host);
            host.appendChild(el("div", "al-loading", "loading object + schema…"));
            getObjectAndSchema(dn, false).then(function (res) {
                var obj = res[0], sch = res[1];
                clear(host);
                host.appendChild(el("h3", null, sch.class_label));
                var strip = el("div", "al-tabstrip");
                var panes = el("div", "al-tabpanes");
                host.appendChild(strip); host.appendChild(panes);
                var editors = {};      // attr -> {orig, get}
                var paneEls = {};
                sch.tabs.forEach(function (tab, ti) {
                    var tb = el("button", "al-tab" + (ti === 0 ? " on" : ""), tab.label); tb.type = "button";
                    var pane = el("div", "al-tabpane" + (ti === 0 ? " on" : ""));
                    tb.addEventListener("click", function () {
                        [].forEach.call(strip.children, function (c) { c.className = "al-tab"; });
                        [].forEach.call(panes.children, function (c) { c.className = "al-tabpane"; });
                        tb.className = "al-tab on"; pane.className = "al-tabpane on";
                    });
                    strip.appendChild(tb); panes.appendChild(pane); paneEls[tab.id] = pane;
                    tab.fields.forEach(function (f) {
                        var orig = obj.attrs[f.attr] || [];
                        var ed = fieldEditor(f, orig);
                        var row = el("div", "al-formrow");
                        var lab = el("label", null, f.label + (f.mandatory ? " *" : ""));
                        row.appendChild(lab); row.appendChild(ed.node);
                        pane.appendChild(row);
                        if (!ed.readonly) editors[f.attr] = { orig: orig, get: ed.get };
                    });
                });
                var bar = el("div", "row al-modal-actions");
                var msg = el("span", "hint", "");
                var save = el("button", "al-btn", "Save");
                save.addEventListener("click", function () {
                    var changes = [];
                    Object.keys(editors).forEach(function (attr) {
                        var nv = editors[attr].get();
                        if (!sameVals(nv, editors[attr].orig)) changes.push({ attr: attr, op: "replace", values: nv });
                    });
                    if (!changes.length) { msg.textContent = " no changes"; return; }
                    save.disabled = true; msg.textContent = " saving " + changes.length + " change(s)…";
                    run("object-modify", { dn: dn, changes: JSON.stringify(changes) }).then(function (r) {
                        if (r.all_ok === false) {
                            var bad = (r.applied || []).filter(function (x) { return x.ok === false; })
                                .map(function (x) { return x.attr; });
                            msg.textContent = " saved, but did not take: " + bad.join(", ");
                        } else {
                            msg.textContent = " saved " + r.changes + " change(s) on " + r.on;
                        }
                        save.disabled = false;
                        if (aducReload) aducReload();
                    }).catch(function (e) { save.disabled = false; msg.textContent = " " + e; });
                });
                var advBtn = el("button", "al-btn secondary", "Attribute Editor ▸");
                advBtn.addEventListener("click", function () { openModal("object-attrs", { target: dn }); });
                var close = el("button", "al-btn secondary", "Close");
                close.addEventListener("click", closeModal);
                bar.appendChild(save); bar.appendChild(advBtn); bar.appendChild(close); bar.appendChild(msg);
                host.appendChild(bar);
            }).catch(function (e) { clear(host); host.appendChild(el("div", "al-alert err", String(e))); });
        }, true);
    }

    // ---- Advanced: filterable grid of ALL attributes -------------------
    function objectAttrsModal(dn) {
        if (!dn) { return; }
        modal("Attribute Editor", function (box) {
            box.appendChild(el("div", "hint", "")).appendChild(el("kbd", "al", dn));
            var filt = el("input", "al-tree-filter-setting"); filt.type = "search"; filt.placeholder = "filter attributes…";
            box.appendChild(filt);
            var showSet = el("label", "al-check");
            var onlySet = el("input"); onlySet.type = "checkbox";
            showSet.appendChild(onlySet); showSet.appendChild(el("span", null, " only attributes with a value"));
            box.appendChild(showSet);
            var host = el("div", "al-attrgrid"); box.appendChild(host);
            host.appendChild(el("div", "al-loading", "loading schema + values…"));
            var obj = null, sch = null, byAttr = {};
            function attrEditable(a) {
                if (a.readonly) return false;
                if (a.type === "binary" || a.type === "sid" || a.type === "ntsd") return false;
                var b = obj.b64 && obj.b64[a.attr];   // value came back as raw binary
                if (b && b.some(function (x) { return x; })) return false;
                return true;
            }
            function draw() {
                clear(host);
                var f = filt.value.toLowerCase();
                var rows = sch.attributes.filter(function (a) {
                    var cur = obj.attrs[a.attr] || [];
                    if (onlySet.checked && !cur.length) return false;
                    if (f && (a.attr + " " + a.label).toLowerCase().indexOf(f) < 0) return false;
                    return true;
                });
                var t = el("table", "al al-attrtable");
                var hr = el("tr"); ["attribute", "syntax", "value", ""].forEach(function (h) { hr.appendChild(el("th", null, h)); });
                t.appendChild(hr);
                rows.slice(0, 400).forEach(function (a) {
                    var cur = obj.attrs[a.attr] || [];
                    var tr = el("tr");
                    var nameCell = el("td"); nameCell.appendChild(el("span", "al-attrname", a.attr + (a.mandatory ? " *" : "")));
                    tr.appendChild(nameCell);
                    tr.appendChild(el("td", "al-attrtype", a.type + (a.multi ? "[]" : "")));
                    var valCell = el("td", "al-wrapcell"); valCell.appendChild(formatValue(a, cur)); tr.appendChild(valCell);
                    var actCell = el("td");
                    if (attrEditable(a)) {
                        var eb = el("button", "al-btn", "edit");
                        eb.addEventListener("click", function () { editAttr(a, cur, valCell, actCell); });
                        actCell.appendChild(eb);
                    }
                    tr.appendChild(actCell);
                    t.appendChild(tr);
                });
                host.appendChild(t);
                host.appendChild(el("div", "hint", rows.length + " attribute(s)" + (rows.length > 400 ? " (showing 400)" : "")));
            }
            function editAttr(a, cur, valCell, actCell) {
                clear(valCell); clear(actCell);
                var ed = fieldEditor(a, cur);
                valCell.appendChild(ed.node);
                var set = el("button", "al-btn", "Set");
                var msg = el("span", "hint", "");
                set.addEventListener("click", function () {
                    var nv = ed.get();
                    set.disabled = true; msg.textContent = " …";
                    run("object-modify", { dn: dn, changes: JSON.stringify([{ attr: a.attr, op: "replace", values: nv }]) })
                        .then(function () { return run("object-get", { dn: dn }); })
                        .then(function (o) { obj = o; if (aducReload) aducReload(); draw(); })
                        .catch(function (e) { set.disabled = false; msg.textContent = " " + e; });
                });
                var cancel = el("button", "al-btn secondary", "cancel");
                cancel.addEventListener("click", draw);
                actCell.appendChild(set); actCell.appendChild(cancel); actCell.appendChild(msg);
            }
            filt.addEventListener("input", function () { if (sch) draw(); });
            onlySet.addEventListener("change", function () { if (sch) draw(); });
            getObjectAndSchema(dn, false).then(function (res) {
                obj = res[0]; sch = res[1];
                sch.attributes.forEach(function (a) { byAttr[a.attr] = a; });
                draw();
            }).catch(function (e) { clear(host); host.appendChild(el("div", "al-alert err", String(e))); });
            var bar = el("div", "row al-modal-actions");
            var close = el("button", "al-btn secondary", "Close"); close.addEventListener("click", closeModal);
            bar.appendChild(close); box.appendChild(bar);
        }, true);
    }

    // ---- rename / delete / other menu ----------------------------------
    function renamePrompt(dn) {
        transientModal("Rename / move", function (box, close) {
            box.appendChild(el("div", "hint", "current: ")).appendChild(el("kbd", "al", dn));
            box.appendChild(el("label", null, "new DN"));
            var inp = el("input", "al-in"); inp.type = "text"; inp.value = dn; box.appendChild(inp);
            box.appendChild(el("div", "hint", "change the RDN to rename, or the parent to move."));
            var msg = el("span", "hint", "");
            var ok = el("button", "al-btn", "Rename");
            ok.addEventListener("click", function () {
                var nd = inp.value.trim();
                if (!nd || nd === dn) { msg.textContent = " unchanged"; return; }
                ok.disabled = true; msg.textContent = " …";
                run("object-rename", { dn: dn, new_dn: nd }).then(function () {
                    aduc.selected = nd; aduc.selectedName = dnRdn(nd); close(); if (aducReload) aducReload();
                }).catch(function (e) { ok.disabled = false; msg.textContent = " " + e; });
            });
            box.appendChild(ok); box.appendChild(msg);
        });
    }
    function deletePrompt(dn) {
        transientModal("Delete object", function (box, close) {
            box.appendChild(el("div", "al-alert warn", "Delete this object? Type its name to confirm."));
            box.appendChild(el("kbd", "al", dn));
            var name = dnRdn(dn);
            var inp = el("input", "al-in"); inp.type = "text"; inp.placeholder = name; box.appendChild(inp);
            var rec = el("label", "al-check"); var recb = el("input"); recb.type = "checkbox";
            rec.appendChild(recb); rec.appendChild(el("span", null, " recursive (delete a container subtree)")); box.appendChild(rec);
            var msg = el("span", "hint", "");
            var ok = el("button", "al-btn danger", "Delete");
            ok.addEventListener("click", function () {
                if (inp.value !== name) { msg.textContent = " name does not match"; return; }
                ok.disabled = true; msg.textContent = " …";
                run("object-delete", { dn: dn, recursive: recb.checked ? "yes" : "" }).then(function () {
                    aduc.selected = null; close(); if (aducReload) aducReload();
                }).catch(function (e) { ok.disabled = false; msg.textContent = " " + e; });
            });
            box.appendChild(ok); box.appendChild(msg);
        });
    }
    function otherMenu(dn) {
        transientModal("Other actions", function (box, close) {
            box.appendChild(el("kbd", "al", dn));
            var name = aduc.selectedSam || aduc.selectedName || dnRdn(dn);
            function act(label, fn) { var b = el("button", "al-btn secondary", label); b.style.display = "block"; b.style.margin = "0.3rem 0"; b.addEventListener("click", fn); box.appendChild(b); }
            var msg = el("div", "hint", "");
            act("Enable account", function () { run("user-enable", { name: name }).then(function () { msg.textContent = "enabled"; if (aducReload) aducReload(); }).catch(function (e) { msg.textContent = String(e); }); });
            act("Disable account", function () { run("user-disable", { name: name }).then(function () { msg.textContent = "disabled"; if (aducReload) aducReload(); }).catch(function (e) { msg.textContent = String(e); }); });
            act("Reset password…", function () { close(); openModal("user-setpassword", { name: name }); });
            act("Move…", function () { close(); renamePrompt(dn); });
            box.appendChild(msg);
        });
    }

    // Protect-from-accidental-deletion toggle for one object.
    function protectPrompt(dn) {
        transientModal("Deletion protection", function (box) {
            box.appendChild(el("div", "hint", "")).appendChild(el("kbd", "al", dn));
            var status = el("div", "al-alert", "checking…"); box.appendChild(status);
            var row = el("div", "row");
            var onBtn = el("button", "al-btn", "Protect");
            var offBtn = el("button", "al-btn secondary", "Remove protection");
            var msg = el("span", "hint", "");
            function refresh() {
                run("object-get", { dn: dn, protected: "yes" }).then(function (o) {
                    status.className = "al-alert " + (o.protected ? "warn" : "ok");
                    status.textContent = o.protected
                        ? "🔒 Protected from accidental deletion."
                        : "Not protected — anyone can delete this object.";
                    onBtn.disabled = o.protected; offBtn.disabled = !o.protected;
                }).catch(function (e) { status.className = "al-alert err"; status.textContent = String(e); });
            }
            function set(state) {
                onBtn.disabled = offBtn.disabled = true; msg.textContent = " …";
                run("object-protect", { dn: dn, state: state }).then(function () {
                    msg.textContent = " done"; refresh(); if (aducReload) aducReload();
                }).catch(function (e) { msg.textContent = " " + e; refresh(); });
            }
            onBtn.addEventListener("click", function () { set("on"); });
            offBtn.addEventListener("click", function () { set("off"); });
            row.appendChild(onBtn); row.appendChild(offBtn);
            box.appendChild(row); box.appendChild(msg);
            refresh();
        });
    }

    // Link / unlink a GPO to a container (OU/domain) — the GPMC workflow, from
    // the tree, using the existing gpo-list + gpo-link/gpo-unlink verbs.
    function gpoLinkPrompt(dn) {
        transientModal("Link Group Policy", function (box) {
            box.appendChild(el("div", "hint", "container: ")).appendChild(el("kbd", "al", dn));
            var host = el("div"); host.appendChild(el("div", "al-loading", "loading GPOs…")); box.appendChild(host);
            var msg = el("span", "hint", ""); var chosen = null;
            run("gpo-list").then(function (r) {
                clear(host);
                var pk = pickerTable({
                    columns: [{ key: "display_name", label: "GPO" }, { key: "gpo", label: "GUID" }],
                    rows: r.gpos || [], mode: "single", height: 240,
                    rowKey: function (g) { return g.gpo; },
                    onChange: function (sel) { chosen = sel[0] || null; },
                });
                host.appendChild(pk.node);
                function act(verb) {
                    if (!chosen) { msg.textContent = " pick a GPO first"; return; }
                    msg.textContent = " …";
                    run(verb, { container_dn: dn, gpo: chosen.gpo }).then(function () {
                        msg.textContent = verb === "gpo-link" ? " linked" : " unlinked";
                    }).catch(function (e) { msg.textContent = " " + e; });
                }
                var link = el("button", "al-btn", "Link");
                link.addEventListener("click", function () { act("gpo-link"); });
                var unlink = el("button", "al-btn danger", "Unlink");
                unlink.addEventListener("click", function () { act("gpo-unlink"); });
                var row = el("div", "row"); row.appendChild(link); row.appendChild(unlink); row.appendChild(msg);
                box.appendChild(row);
            }).catch(function (e) { clear(host); host.appendChild(el("div", "al-alert err", String(e))); });
        });
    }

    // Add a user to a group — the ADUC 'Add to a group' workflow, backed by the
    // existing group-add-member verb (memberOf is read-only on the object).
    function addToGroupPrompt(sam) {
        transientModal("Add to a group", function (box) {
            box.appendChild(el("div", "hint", "member: ")).appendChild(el("kbd", "al", sam));
            var host = el("div"); host.appendChild(el("div", "al-loading", "loading groups…")); box.appendChild(host);
            var msg = el("span", "hint", ""); var chosen = null;
            run("group-list").then(function (r) {
                clear(host);
                var rows = (r.groups || []).map(function (g) { return { group: g }; });
                var pk = pickerTable({
                    columns: [{ key: "group", label: "group" }],
                    rows: rows, mode: "single", height: 240,
                    rowKey: function (g) { return g.group; },
                    onChange: function (sel) { chosen = sel[0] || null; },
                });
                host.appendChild(pk.node);
                var add = el("button", "al-btn", "Add to group");
                add.addEventListener("click", function () {
                    if (!chosen) { msg.textContent = " pick a group first"; return; }
                    msg.textContent = " …";
                    run("group-add-member", { group: chosen.group, member: sam }).then(function () {
                        msg.textContent = " added to " + chosen.group; if (aducReload) aducReload();
                    }).catch(function (e) { msg.textContent = " " + e; });
                });
                var row = el("div", "row"); row.appendChild(add); row.appendChild(msg);
                box.appendChild(row);
            }).catch(function (e) { clear(host); host.appendChild(el("div", "al-alert err", String(e))); });
        });
    }

    var aducSelect = null;   // set by renderObjects: select+preview a DN in the console

    // A floating right-click / kebab context menu. items are
    // {label, onClick, danger?, disabled?, submenu:[…]} or {sep:true}.
    var _ctxMenu = null;
    function closeContextMenu() {
        if (!_ctxMenu) return;
        document.removeEventListener("mousedown", _ctxMenu._down, true);
        document.removeEventListener("keydown", _ctxMenu._esc, true);
        if (_ctxMenu.parentNode) _ctxMenu.parentNode.removeChild(_ctxMenu);
        _ctxMenu = null;
    }
    function contextMenu(x, y, items) {
        closeContextMenu();
        var menu = el("div", "al-ctxmenu"); menu.setAttribute("role", "menu"); menu.tabIndex = -1;
        function levelItems(node) {
            return [].filter.call(node.children, function (c) {
                return c.classList && c.classList.contains("al-ctxitem") && !c.classList.contains("disabled");
            });
        }
        function focusFirst(node) { var it = levelItems(node)[0]; if (it) it.focus(); }
        function mkItem(it, host) {
            if (it.sep) { host.appendChild(el("div", "al-ctxsep")); return; }
            var mi = el("div", "al-ctxitem" + (it.danger ? " danger" : "") +
                        (it.disabled ? " disabled" : "") + (it.submenu ? " has-sub" : ""));
            mi.setAttribute("role", "menuitem");
            mi.appendChild(el("span", "al-ctxlabel", it.label));
            if (it.submenu) {
                mi.appendChild(el("span", "al-ctxarrow", "▸"));
                var sub = el("div", "al-ctxsub");
                it.submenu.forEach(function (s) { mkItem(s, sub); });
                mi.appendChild(sub); mi._sub = sub;
                if (!it.disabled) mi.tabIndex = -1;
            } else if (!it.disabled) {
                mi.tabIndex = -1;
                mi._activate = function () { closeContextMenu(); it.onClick(); };
                mi.addEventListener("click", function (ev) { ev.stopPropagation(); mi._activate(); });
            }
            host.appendChild(mi);
        }
        items.forEach(function (it) { mkItem(it, menu); });
        document.body.appendChild(menu);
        var r = menu.getBoundingClientRect();
        var leftPx = Math.max(4, Math.min(x, window.innerWidth - r.width - 8));
        menu.style.left = leftPx + "px";
        menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + "px";
        if (leftPx + r.width + 190 > window.innerWidth) menu.classList.add("sub-left");  // flip submenus

        menu.addEventListener("keydown", function (ev) {
            var focused = document.activeElement;
            var inSub = focused && focused.parentNode && focused.parentNode.classList.contains("al-ctxsub");
            var level = inSub ? focused.parentNode : menu;
            var list = levelItems(level), i = list.indexOf(focused);
            if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                ev.preventDefault();
                if (!inSub) [].forEach.call(menu.querySelectorAll(".al-ctxsub.open"), function (s) { s.classList.remove("open"); });
                var n = ev.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
                if (list[n]) list[n].focus();
            } else if (ev.key === "ArrowRight" || ev.key === "Enter" || ev.key === " ") {
                if (focused && focused._sub) { ev.preventDefault(); focused._sub.classList.add("open"); focusFirst(focused._sub); }
                else if (focused && focused._activate) { ev.preventDefault(); focused._activate(); }
            } else if (ev.key === "ArrowLeft" && inSub) {
                ev.preventDefault(); level.classList.remove("open"); if (level.parentNode) level.parentNode.focus();
            }
        });

        menu._down = function (ev) { if (_ctxMenu && !_ctxMenu.contains(ev.target)) closeContextMenu(); };
        menu._esc = function (ev) { if (ev.key === "Escape") { ev.preventDefault(); closeContextMenu(); } };
        _ctxMenu = menu;
        document.addEventListener("mousedown", menu._down, true);
        document.addEventListener("keydown", menu._esc, true);
        focusFirst(menu);
    }

    function makeSplitter(splitEl, pane, min, max, onWidth, right) {
        splitEl.addEventListener("mousedown", function (ev) {
            ev.preventDefault();
            var startX = ev.clientX, startW = pane.offsetWidth;
            function move(e) {
                var d = right ? (startX - e.clientX) : (e.clientX - startX);
                var w = Math.max(min, Math.min(max, startW + d));
                pane.style.width = w + "px"; if (onWidth) onWidth(w);
            }
            function up() { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); }
            document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
        });
    }

    // ----------------------------------------------------------------- gpo
    function renderGpo() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("New GPO", "gpo-create", {}, ""));
        var admxBtn = el("button", "al-btn secondary", "ADMX central store (Windows + Linux)");
        admxBtn.addEventListener("click", function () { openModal("gpo-admx"); });
        acts.appendChild(admxBtn);
        var tplBtn = el("button", "al-btn secondary", "Templates");
        tplBtn.addEventListener("click", function () { openModal("gpo-templates"); });
        acts.appendChild(tplBtn);
        acts.appendChild(actionButton("Sync SYSVOL now", "sysvol-sync", {}));
        m.appendChild(acts);
        m.appendChild(el("div", "al-alert warn",
            "All GPO writes land on the PDC emulator (queried live). Administrative-" +
            "Template settings become registry.pol via `gpo load`; preferences use " +
            "samba CSEs (`gpo manage`); SYSVOL replicates within 5 minutes. " +
            "The ADMX central store carries both Windows and Linux (Ubuntu/adsys) " +
            "administrative templates — open it to install or review Linux policy. " +
            "Each GPO is created Windows- or Linux-exclusive (the OS column): only " +
            "that OS's settings may be written to it, so a Linux setting never " +
            "applies on Windows and vice versa. Use “set OS” to scope a legacy GPO."));
        var holder = el("div", "al-grid"); m.appendChild(holder);
        var fGpo = slotCard(holder, "Group Policy objects", true);
        run("gpo-list").then(function (r) {
            fGpo(emptyOr(r.gpos, ["GPO", "display name", "OS", "ver", "actions"], function (g) {
                var box = el("div", "al-actions");
                var edit = el("button", "al-btn", "edit");
                edit.addEventListener("click", function () { openModal("gpo-edit", { target: g.gpo }); });
                box.appendChild(edit);
                var detail = el("button", "al-btn secondary", "settings");
                detail.addEventListener("click", function () { openModal("gpo-detail", { target: g.gpo }); });
                box.appendChild(detail);
                var prefs = el("button", "al-btn secondary", "preferences");
                prefs.addEventListener("click", function () { openModal("gpo-prefs", { target: g.gpo }); });
                box.appendChild(prefs);
                box.appendChild(actionButton("set OS", "gpo-set-os", { gpo: g.gpo }));
                box.appendChild(actionButton("backup", "gpo-backup", { gpo: g.gpo }));
                box.appendChild(actionButton("link", "gpo-link", { gpo: g.gpo }));
                box.appendChild(actionButton("unlink", "gpo-unlink", { gpo: g.gpo }));
                box.appendChild(actionButton("delete", "gpo-delete", { gpo: g.gpo }));
                // OS scope: Windows-/Linux-exclusive (blank = untyped legacy GPO)
                var osCell = g.os_scope
                    ? el("span", "badge " + (g.os_scope === "Linux" ? "lnx" : "win"), g.os_scope)
                    : el("span", "hint", "—");
                return [el("kbd", "al", g.gpo), g.display_name, osCell, g.version, box];
            }, "no GPOs"), "Group Policy objects (on " + r.pdc_emulator + ")");
        }).catch(function (e) { fGpo(el("div", "al-alert err", String(e))); });
    }

    // -------- shared GPO constants + widgets (registry types, CSE list, pickerTable)
    var REG_TYPES = ["REG_SZ", "REG_EXPAND_SZ", "REG_DWORD", "REG_QWORD",
                     "REG_MULTI_SZ", "REG_BINARY"];
    var GPO_CSES = ["smb_conf", "security", "motd", "issue", "sudoers",
                    "files", "symlink", "openssh", "scripts", "access"];

    function dataPreview(type, data) {
        if (type === "REG_BINARY" && Array.isArray(data))
            return data.slice(0, 24).map(function (b) { return ("0" + (b & 255).toString(16)).slice(-2); }).join(" ") + (data.length > 24 ? " …" : "");
        if (type === "REG_MULTI_SZ" && Array.isArray(data)) return data.join(" ¦ ");
        return String(data === undefined || data === null ? "" : data);
    }

    /* Reusable picker: a filterable table with a vertically scrolling body and
     * horizontal scroll, single- or multi-select. Cells cap at 420px and wrap.
     * opts: {columns:[{key,label}], rows, mode:"single"|"multi", rowKey,
     *        height, selectedKeys, actions:row->node, onChange:rows->void} */
    function pickerTable(opts) {
        var mode = opts.mode || "single";
        var rowKey = opts.rowKey || function (r, i) { return String(i); };
        var selected = {};
        (opts.selectedKeys || []).forEach(function (k) { selected[k] = true; });
        var wrap = el("div", "al-picker");
        var filter = el("input", "al-picker-filter"); filter.type = "search";
        filter.placeholder = "filter…"; wrap.appendChild(filter);
        var scroll = el("div", "al-picker-scroll");
        if (opts.height) scroll.style.maxHeight = opts.height + "px";
        var table = el("table", "al al-picker-table");
        scroll.appendChild(table); wrap.appendChild(scroll);
        var countEl = el("div", "al-picker-count"); wrap.appendChild(countEl);
        var rows = opts.rows || [];

        function matches(row, q) {
            if (!q) return true;
            q = q.toLowerCase();
            return opts.columns.some(function (c) {
                return String(row[c.key] == null ? "" : row[c.key]).toLowerCase().indexOf(q) >= 0;
            });
        }
        function keyFor(row, i) { return rowKey(row, i); }
        function toggle(k, row, on) {
            if (mode === "single") selected = {};
            if (on) selected[k] = row; else delete selected[k];
            if (opts.onChange) opts.onChange(list());
            draw();
        }
        function list() {
            var out = [];
            rows.forEach(function (r, i) { if (selected[keyFor(r, i)]) out.push(r); });
            return out;
        }
        function draw() {
            clear(table);
            var head = el("tr");
            head.appendChild(el("th", "al-pick-selcol", ""));
            opts.columns.forEach(function (c) { head.appendChild(el("th", null, c.label)); });
            if (opts.actions) head.appendChild(el("th", null, ""));
            table.appendChild(head);
            var q = filter.value, shown = 0;
            rows.forEach(function (row, i) {
                if (!matches(row, q)) return;
                shown++;
                var k = keyFor(row, i);
                var tr = el("tr", selected[k] ? "al-pick-sel" : "");
                var selTd = el("td", "al-pick-selcol");
                var input = el("input"); input.type = mode === "multi" ? "checkbox" : "radio";
                input.checked = !!selected[k];
                input.addEventListener("change", function () { toggle(k, row, input.checked); });
                selTd.appendChild(input); tr.appendChild(selTd);
                tr.addEventListener("click", function (ev) {
                    var tag = ev.target.tagName;
                    if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
                    toggle(k, row, !selected[k]);
                });
                opts.columns.forEach(function (c) {
                    var td = el("td", "al-wrapcell");
                    var v = row[c.key];
                    td.textContent = v == null ? "" : String(v);
                    tr.appendChild(td);
                });
                if (opts.actions) { var atd = el("td"); atd.appendChild(opts.actions(row)); tr.appendChild(atd); }
                table.appendChild(tr);
            });
            countEl.textContent = shown + " shown · " + list().length + " selected";
        }
        filter.addEventListener("input", draw);
        draw();
        return {
            node: wrap, selected: list,
            setRows: function (r) { rows = r; selected = {}; draw(); },
            clearSel: function () { selected = {}; draw(); }
        };
    }

    /* Editor for one registry value. Adapts to the type (single-select picker),
     * with Hex/Text view-mode selection for REG_BINARY and one-string-per-line
     * for REG_MULTI_SZ (stored null-separated, double-null terminated). */
    /* The ADMX policy editor: an OS-filtered category tree (left) -> policy list
     * -> a per-policy detail form (tri-state + one control per ADMX element,
     * typed from the ADML presentation). Replaces the old facet tree + the raw
     * "compose" stack. Reads gpo-edit-context / gpo-policy-list / -schema / -read
     * and writes via gpo-policy-compile (the ADMX->registry.pol compiler). */
    function gpoEditModal(target) {
        if (!target) { return; }
        function tru(v) { return v === true || String(v) === "1" || String(v).toLowerCase() === "true"; }
        var osScope = "", treeData = [], treeFilter = "", expanded = {}, lastCat = null;

        modal("Edit Group Policy", function (box) {
            var head = el("div", "al-edit-head");
            var nameEl = el("div", "al-edit-gpo-name", "…");
            var meta = el("div", "hint", "GPO: ");
            meta.appendChild(el("kbd", "al", target));
            var osBadge = el("span", "badge dim", "OS: …");
            meta.appendChild(document.createTextNode("  ")); meta.appendChild(osBadge);
            head.appendChild(nameEl); head.appendChild(meta);
            box.appendChild(head);
            run("gpo-show", { gpo: target }).then(function (r) {
                var n = r && r.meta && r.meta.display_name;
                nameEl.textContent = n || "(unnamed GPO)";
            }, function () { nameEl.textContent = "(name unavailable)"; });

            var panes = el("div", "al-edit-panes");
            var treePane = el("div", "al-edit-tree"); treePane.style.width = "420px";
            var splitter = el("div", "al-edit-splitter");
            var rightPane = el("div", "al-edit-list");
            panes.appendChild(treePane); panes.appendChild(splitter); panes.appendChild(rightPane);
            box.appendChild(panes);
            splitter.addEventListener("mousedown", function (ev) {
                ev.preventDefault();
                var sx = ev.clientX, sw = treePane.offsetWidth;
                function mv(e) { treePane.style.width = Math.max(240, Math.min(760, sw + (e.clientX - sx))) + "px"; }
                function up() { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); }
                document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
            });

            var fbar = el("div", "al-tree-filters");
            var fin = el("input", "al-tree-filter-setting"); fin.type = "search"; fin.placeholder = "filter categories…";
            fin.addEventListener("input", function () { treeFilter = fin.value.toLowerCase(); drawTree(); });
            fbar.appendChild(fin);
            treePane.appendChild(fbar);
            var treeHost = el("div"); treePane.appendChild(treeHost);
            function resetRight() { clear(rightPane); rightPane.appendChild(el("div", "hint", "Select a category on the left to list its policies.")); }
            resetRight();

            function catMatches(n) {
                if (!treeFilter) return true;
                if ((n.display || "").toLowerCase().indexOf(treeFilter) >= 0) return true;
                return (n.children || []).some(catMatches);
            }
            function drawNode(node, depth) {
                if (!catMatches(node)) return;
                var hasKids = (node.children || []).length > 0;
                var open = !!expanded[node.gid] || !!treeFilter;
                var row = el("div", "al-tree-row" + (lastCat && lastCat.gid === node.gid ? " sel" : ""));
                row.style.paddingLeft = (depth * 14 + 6) + "px";
                row.appendChild(el("span", "al-tree-tog", hasKids ? (open ? "▾" : "▸") : ""));
                row.appendChild(el("span", "al-tree-label", node.display));
                row.appendChild(badge(String(node.count), "dim"));
                row.addEventListener("click", function () {
                    expanded[node.gid] = !open;
                    if (node.policy_count > 0) loadPolicies(node);
                    drawTree();
                });
                treeHost.appendChild(row);
                if (hasKids && open) node.children.forEach(function (c) { drawNode(c, depth + 1); });
            }
            function drawTree() {
                clear(treeHost);
                if (!treeData.length) { treeHost.appendChild(el("div", "hint", "no categories")); return; }
                treeData.forEach(function (n) { drawNode(n, 0); });
            }

            function loadPolicies(node) {
                lastCat = node;
                clear(rightPane);
                rightPane.appendChild(el("h3", "al-edit-cat", node.display));
                var host = el("div"); rightPane.appendChild(host);
                host.appendChild(el("div", "al-loading", "loading…"));
                run("gpo-policy-list", { category: node.gid, os: osScope || undefined }).then(function (r) {
                    clear(host);
                    if (!(r.policies || []).length) { host.appendChild(el("div", "hint", "no policies in this category")); return; }
                    var filt = el("input", "al-tree-filter-setting"); filt.type = "search"; filt.placeholder = "filter policies…";
                    host.appendChild(filt);
                    var listBox = el("div", "al-pol-list"); host.appendChild(listBox);
                    function draw() {
                        clear(listBox);
                        var q = filt.value.toLowerCase();
                        r.policies.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) >= 0; })
                            .forEach(function (p) {
                                var row = el("div", "al-pol-row");
                                row.appendChild(el("span", "al-pol-name", p.name));
                                if (p.class === "USER") row.appendChild(badge("user", "dim"));
                                if (p.unresolved) row.appendChild(badge("raw", "warn"));
                                row.addEventListener("click", function () { openPolicy(p.id); });
                                listBox.appendChild(row);
                            });
                    }
                    filt.addEventListener("input", draw); draw();
                }).catch(function (e) { clear(host); host.appendChild(el("div", "al-alert err", String(e))); });
            }

            function renderControl(elem, cur) {
                var kind = elem.kind, node, get;
                if (kind === "boolean") {
                    node = el("input"); node.type = "checkbox";
                    node.checked = (cur !== undefined && cur !== null) ? tru(cur) : !!elem.default;
                    get = function () { return node.checked; };
                } else if (kind === "enum") {
                    node = el("select");
                    (elem.items || []).forEach(function (it) {
                        var o = el("option", null, it.display); o.value = String(it.value); node.appendChild(o);
                    });
                    var seed = (cur !== undefined && cur !== null) ? String(cur)
                        : (elem.default_item != null && elem.items && elem.items[elem.default_item] ? String(elem.items[elem.default_item].value) : "");
                    if (seed !== "") node.value = seed;
                    get = function () {
                        var v = node.value, it = (elem.items || []).filter(function (x) { return String(x.value) === v; })[0];
                        return it ? it.value : v;
                    };
                } else if (kind === "decimal" || kind === "longDecimal") {
                    node = el("input"); node.type = "number";
                    if (elem.min != null) node.min = elem.min;
                    if (elem.max != null) node.max = elem.max;
                    node.value = (cur !== undefined && cur !== null) ? cur : (elem.default != null ? elem.default : "");
                    get = function () { return node.value === "" ? "" : node.value; };
                } else if (kind === "multiText" || kind === "list") {
                    node = el("textarea"); node.rows = 4;
                    node.placeholder = kind === "list" ? (elem.explicit ? "one name=value per line" : "one value per line") : "one string per line";
                    node.value = Array.isArray(cur) ? cur.join("\n") : (cur || "");
                    get = function () { return node.value.split("\n").filter(function (x) { return x.trim() !== ""; }); };
                } else {
                    node = el("input"); node.type = "text";
                    if (elem.maxlen) node.maxLength = elem.maxlen;
                    node.value = (cur !== undefined && cur !== null) ? cur : (elem.default != null ? elem.default : "");
                    get = function () { return node.value; };
                }
                node.classList.add("al-el-ctl");
                return { node: node, get: get, elem: elem };
            }

            function openPolicy(pid) {
                clear(rightPane);
                rightPane.appendChild(el("div", "al-loading", "loading policy…"));
                Promise.all([run("gpo-policy-schema", { id: pid }),
                             run("gpo-policy-read", { gpo: target, id: pid }).catch(function () { return { state: "notconfigured", values: {} }; })])
                    .then(function (res) {
                        var sch = res[0], cur = res[1] || {};
                        clear(rightPane);
                        var back = el("button", "al-btn secondary", "← policies");
                        back.addEventListener("click", function () { if (lastCat) loadPolicies(lastCat); else resetRight(); });
                        rightPane.appendChild(back);
                        rightPane.appendChild(el("h3", "al-edit-cat", sch.name));
                        if (sch.supported) rightPane.appendChild(el("div", "hint", "Supported on: " + sch.supported));
                        if (sch.explain) rightPane.appendChild(el("div", "al-explain", sch.explain));

                        var form = el("form", "al-form");
                        var canEnable = sch.has_enabled || (sch.elements || []).length || (sch.enabled_list || []).length;
                        var st = cur.state || "notconfigured";
                        var radios = {}, triRow = el("div", "al-tri");
                        [["notconfigured", "Not Configured"],
                         canEnable ? ["enabled", "Enabled"] : null,
                         (sch.has_disabled || sch.has_enabled) ? ["disabled", "Disabled"] : null]
                          .filter(Boolean).forEach(function (opt) {
                            var lab = el("label", "al-tri-opt");
                            var r = el("input"); r.type = "radio"; r.name = "tristate-" + pid; r.value = opt[0];
                            if (st === opt[0]) r.checked = true;
                            radios[opt[0]] = r;
                            r.addEventListener("change", syncEnabled);
                            lab.appendChild(r); lab.appendChild(document.createTextNode(" " + opt[1]));
                            triRow.appendChild(lab);
                        });
                        if (!radios[st] && radios.notconfigured) radios.notconfigured.checked = true;
                        form.appendChild(triRow);

                        var elemHost = el("div", "al-el-block"), controls = [];
                        (sch.elements || []).forEach(function (elem) {
                            var wrap = el("div", "al-el");
                            var lab = el("label", "al-el-label", elem.label || elem.id);
                            if (elem.required) lab.appendChild(el("span", "hint", " *"));
                            wrap.appendChild(lab);
                            var c = renderControl(elem, (cur.values || {})[elem.id]);
                            wrap.appendChild(c.node);
                            elemHost.appendChild(wrap);
                            controls.push(c);
                        });
                        form.appendChild(elemHost);
                        function syncEnabled() {
                            var en = radios.enabled && radios.enabled.checked;
                            elemHost.style.opacity = en ? "1" : "0.5";
                            controls.forEach(function (c) { c.node.disabled = !en; });
                        }
                        syncEnabled();

                        var alertBox = el("div", "al-alert err"); form.appendChild(alertBox);
                        var rowb = el("div", "row");
                        var save = el("button", "al-btn", "Save"); save.type = "submit";
                        var cancel = el("button", "al-btn secondary", "Cancel"); cancel.type = "button";
                        cancel.addEventListener("click", function () { if (lastCat) loadPolicies(lastCat); });
                        rowb.appendChild(save); rowb.appendChild(cancel); form.appendChild(rowb);

                        form.addEventListener("submit", function (ev) {
                            ev.preventDefault(); alertBox.textContent = "";
                            var state = Object.keys(radios).filter(function (k) { return radios[k].checked; })[0] || "notconfigured";
                            var values = {}, bad = null;
                            if (state === "enabled") {
                                controls.forEach(function (c) {
                                    var v = c.get();
                                    var empty = (v === "" || v == null || (Array.isArray(v) && !v.length));
                                    if (c.elem.required && empty) bad = bad || ((c.elem.label || c.elem.id) + " is required");
                                    if ((c.elem.kind === "decimal" || c.elem.kind === "longDecimal") && v !== "") {
                                        var nv = Number(v);
                                        if (c.elem.min != null && nv < c.elem.min) bad = bad || ((c.elem.label || c.elem.id) + " min is " + c.elem.min);
                                        if (c.elem.max != null && nv > c.elem.max) bad = bad || ((c.elem.label || c.elem.id) + " max is " + c.elem.max);
                                    }
                                    values[c.elem.id] = v;
                                });
                            }
                            if (bad) { alertBox.textContent = bad; return; }
                            save.disabled = true;
                            var args = { gpo: target, id: pid, state: state, apply: "true" };
                            if (state === "enabled") args.values = JSON.stringify(values);
                            if (sch.class === "BOTH") args["class"] = "MACHINE";
                            run("gpo-policy-compile", args).then(function (r) {
                                transientModal("Saved", function (b, close) {
                                    b.appendChild(el("div", "al-alert " + (r.os_auto_set ? "warn" : "ok"),
                                        "Policy set " + state +
                                        (r.os_auto_set ? " — this GPO's OS scope was set to " + r.os_auto_set : "") +
                                        " (" + ((r.entries || []).length) + " value(s) written, " + ((r.removed || []).length) + " removed)."));
                                    var ok = el("button", "al-btn", "Close"); ok.addEventListener("click", close); b.appendChild(ok);
                                });
                                if (lastCat) loadPolicies(lastCat);
                            }).catch(function (e) { save.disabled = false; alertBox.textContent = String(e); });
                        });
                        rightPane.appendChild(form);
                    }).catch(function (e) { clear(rightPane); rightPane.appendChild(el("div", "al-alert err", String(e))); });
            }

            // bootstrap: resolve + lock the GPO's OS (set if missing), draw the tree
            run("gpo-edit-context", { gpo: target }).then(function (r) {
                osScope = r.os || "";
                var src = (r.os_source || "");
                osBadge.textContent = "OS: " + (r.os || "any") + (src.indexOf("set") === 0 ? " (set)" : "");
                osBadge.className = "badge " + (r.os === "Linux" ? "lnx" : (r.os === "Windows" ? "win" : "dim"));
                treeData = r.tree || [];
                drawTree();
            }).catch(function (e) { clear(treeHost); treeHost.appendChild(el("div", "al-alert err", String(e))); });
        }, true, "gpo-edit");
    }

    // Classify an ADMX file by OS the same way adlab-admin's _derive_tags does,
    // so the central-store view can separate Windows from Linux templates.
    function admxOs(name) {
        var r = (name || "").toLowerCase();
        if (r.indexOf("ubuntu") >= 0 || r.indexOf("adsys") >= 0 || r.indexOf("canonical") >= 0) return "Linux";
        if (r.indexOf("gnome") >= 0 || r.indexOf("samba") >= 0) return "Linux";
        return "Windows";
    }

    function gpoAdmxModal() {
        modal("ADMX central store — Windows & Linux templates", function (box) {
            var actions = el("div", "al-actions");
            var loadBtn = el("button", "al-btn secondary", "Load samba ADMX into SYSVOL");
            var seedBtn = el("button", "al-btn", "Install Linux (Ubuntu/adsys) templates");
            var reportBtn = el("button", "al-btn secondary", "GPOs with Linux settings");
            actions.appendChild(loadBtn); actions.appendChild(seedBtn); actions.appendChild(reportBtn);
            box.appendChild(actions);
            var msg = el("div", "hint", ""); box.appendChild(msg);
            var out = el("div"); out.appendChild(el("div", "al-loading", "listing central store…"));
            box.appendChild(out);
            var reportOut = el("div"); box.appendChild(reportOut);

            function refresh() {
                run("gpo-admx-list").then(function (r) {
                    clear(out);
                    var files = (r.admx_files || []);
                    var lin = files.filter(function (f) { return admxOs(f) === "Linux"; });
                    var win = files.filter(function (f) { return admxOs(f) === "Windows"; });
                    var sum = el("div", "al-grid");
                    var lc = card("Linux administrative templates (" + lin.length + ")");
                    lc.appendChild(el("div", "hint", lin.length ? lin.join(", ")
                        : "none yet — click ‘Install Linux (Ubuntu/adsys) templates’"));
                    sum.appendChild(lc);
                    var wc = card("Windows administrative templates (" + win.length + ")");
                    wc.appendChild(el("div", "hint", win.length
                        ? (win.slice(0, 14).join(", ") + (win.length > 14 ? " …" : ""))
                        : "none yet — click ‘Load samba ADMX into SYSVOL’"));
                    sum.appendChild(wc);
                    out.appendChild(sum);
                    out.appendChild(el("div", "hint", "Policies available: " + (r.policy_count || 0) +
                        " (" + (r.resolved_count || 0) + " named). Linux rows first."));
                    var pols = (r.policies || []).slice();
                    pols.sort(function (a, b) {
                        return (admxOs(a.admx) === "Linux" ? 0 : 1) - (admxOs(b.admx) === "Linux" ? 0 : 1);
                    });
                    out.appendChild(tableOf(["OS", "policy", "class", "ADMX", "key"],
                        pols.slice(0, 400).map(function (p) {
                            return [admxOs(p.admx), p.display || p.id, p.class, p.admx,
                                    p.key + "\\" + p.valuename];
                        })));
                }).catch(function (e) { clear(out); out.appendChild(el("div", "al-alert err", String(e))); });
            }
            loadBtn.addEventListener("click", function () {
                loadBtn.disabled = true; msg.textContent = " loading samba ADMX…";
                run("gpo-admxload").then(function () {
                    loadBtn.disabled = false; msg.textContent = " samba ADMX loaded."; refresh();
                }).catch(function (e) {
                    loadBtn.disabled = false; msg.textContent = ""; clear(out);
                    out.appendChild(el("div", "al-alert err", String(e)));
                });
            });
            seedBtn.addEventListener("click", function () {
                seedBtn.disabled = true; msg.textContent = " generating + installing Ubuntu Linux ADMX…";
                run("gpo-linux-seed").then(function (r) {
                    seedBtn.disabled = false;
                    msg.textContent = (r.applied === false)
                        ? " Linux templates already installed (" + (r.policies || "?") + " policies)."
                        : " installed " + (r.admx || "Ubuntu.admx") + " — " + (r.policies || "?") +
                          " policies across " + (r.categories || "?") + " categories on " + (r.on || "the PDC") + ".";
                    refresh();
                    // rebuild the catalog cache so the editor's Linux facet shows the new policies
                    run("gpo-catalog", { source: "admx", refresh: "true" }).catch(function () {});
                }).catch(function (e) {
                    seedBtn.disabled = false; msg.textContent = ""; clear(out);
                    out.appendChild(el("div", "al-alert err", String(e)));
                });
            });
            reportBtn.addEventListener("click", function () {
                clear(reportOut);
                reportOut.appendChild(el("div", "al-loading", "scanning GPOs for Linux settings…"));
                run("gpo-linux-report").then(function (r) {
                    clear(reportOut);
                    var c = card("GPOs with Linux settings (" + r.linux_count + " of " + r.total + ")");
                    c.appendChild(tableOf(["Linux?", "GPO", "display name", "reg keys", "CSE"],
                        (r.gpos || []).map(function (g) {
                            return [g.linux ? "yes" : "—", el("kbd", "al", g.gpo), g.display_name,
                                    String((g.registry_keys || []).length),
                                    String((g.cse_artifacts || []).length)];
                        })));
                    c.appendChild(el("div", "hint", "Linux key roots: " + (r.reg_roots || []).join(", ") +
                        "; CSE = samba Unix preference artifacts in the GPO's SYSVOL."));
                    reportOut.appendChild(c);
                }).catch(function (e) {
                    clear(reportOut); reportOut.appendChild(el("div", "al-alert err", String(e)));
                });
            });
            var close = el("button", "al-btn secondary", "Close");
            close.addEventListener("click", closeModal); box.appendChild(close);
            refresh();
        });
    }

    function gpoTemplatesModal() {
        modal("GPO templates", function (box) {
            var out = el("div"); out.appendChild(el("div", "al-loading", "loading…"));
            run("gpo-template-list").then(function (r) {
                clear(out);
                var c1 = card("Saved backups (restore as a new GPO)");
                if (!(r.backups || []).length) c1.appendChild(el("div", "hint", "none — use a GPO's ‘backup’ action first"));
                (r.backups || []).forEach(function (b) {
                    var row = el("div", "al-stack-row");
                    row.appendChild(el("span", "al-stack-label", b));
                    row.appendChild(actionButton("restore as new GPO", "gpo-restore", { template: b }));
                    c1.appendChild(row);
                });
                out.appendChild(c1);
                var c2 = card("Existing GPOs (usable as stacking sources)");
                c2.appendChild(tableOf(["GPO", "display name"], (r.gpos || []).map(function (g) {
                    return [el("kbd", "al", g.gpo), g.display_name];
                })));
                out.appendChild(c2);
            }).catch(function (e) { clear(out); out.appendChild(el("div", "al-alert err", String(e))); });
            box.appendChild(out);
            var close = el("button", "al-btn secondary", "Close");
            close.addEventListener("click", closeModal); box.appendChild(close);
        });
    }

    function gpoPrefsModal(gpo) {
        if (!gpo) { return; }
        // The samba CSE preferences ARE the "available policy" here; each targets
        // an OS + subsystems (from the catalog, override-aware). An OS/subsystem
        // filter lets the operator sort through them by platform instead of
        // scanning one flat list — the same faceting the full editor uses.
        var CSE_FALLBACK = ["smb_conf", "security", "motd", "issue", "sudoers",
                            "files", "symlink", "openssh", "scripts", "access"];
        modal("GPO preferences (CSEs)", function (box) {
            box.appendChild(el("div", "hint", "GPO: ")).appendChild(el("kbd", "al", gpo));

            var cses = [];            // [{cse, name, os_type, subsystems}]
            var osTypes = [], subsystems = [];
            var fOs = "", fSubs = {};

            // ---- OS / subsystem filter bar --------------------------------
            var filterBar = el("div", "al-tree-filters");
            var osWrap = el("div", "al-facet-row");
            osWrap.appendChild(el("span", "al-facet-lbl", "OS"));
            var osSel = el("select", "al-dom-select");
            var allOpt = el("option", null, "All OSes"); allOpt.value = ""; osSel.appendChild(allOpt);
            osWrap.appendChild(osSel);
            var subRow = el("div", "al-facet-row");
            subRow.appendChild(el("span", "al-facet-lbl", "subsystems"));
            filterBar.appendChild(osWrap); filterBar.appendChild(subRow);
            box.appendChild(filterBar);

            var cse = el("select");
            var matchHint = el("div", "hint", "loading policy catalog…");
            box.appendChild(el("label", null, "CSE")); box.appendChild(cse); box.appendChild(matchHint);

            var entry = el("input"); entry.placeholder = "entry (per CSE)";
            var value = el("input"); value.placeholder = "value (empty unsets)";
            box.appendChild(el("label", null, "entry")); box.appendChild(entry);
            box.appendChild(el("label", null, "value")); box.appendChild(value);
            var setBtn = el("button", "al-btn", "Set preference");
            var msg = el("span", "hint", "");
            box.appendChild(setBtn); box.appendChild(msg);
            var listOut = el("div"); box.appendChild(listOut);
            var close = el("button", "al-btn secondary", "Close");
            close.addEventListener("click", closeModal); box.appendChild(close);

            function matches(c) {
                if (fOs && c.os_type && c.os_type !== fOs) return false;
                if (Object.keys(fSubs).length &&
                    !(c.subsystems || []).some(function (s) { return fSubs[s]; })) return false;
                return true;
            }
            function listCse() {
                clear(listOut);
                if (!cse.value) return;
                listOut.appendChild(el("div", "al-loading", "listing…"));
                run("gpo-pref-list", { gpo: gpo, cse: cse.value }).then(function (r) {
                    clear(listOut);
                    listOut.appendChild(tableOf([cse.value + " items"],
                        (r.items || []).map(function (i) { return [i]; })));
                    if (!(r.items || []).length) listOut.appendChild(el("div", "hint", "(none set)"));
                }).catch(function (e) { clear(listOut); listOut.appendChild(el("div", "al-alert err", String(e))); });
            }
            function rebuildCseOptions() {
                var prev = cse.value;
                clear(cse);
                var shown = cses.filter(matches);
                shown.forEach(function (c) { var o = el("option", null, c.cse); o.value = c.cse; cse.appendChild(o); });
                if (!shown.length) {
                    var o = el("option", null, "(no CSE for this OS / subsystem)"); o.value = ""; cse.appendChild(o);
                }
                if (prev && shown.some(function (c) { return c.cse === prev; })) cse.value = prev;
                matchHint.textContent = shown.length + " of " + cses.length + " preference type" +
                    (cses.length === 1 ? "" : "s") + " shown";
                listCse();
            }
            function drawSubs() {
                while (subRow.childNodes.length > 1) subRow.removeChild(subRow.lastChild);
                var present = {};
                cses.forEach(function (c) { (c.subsystems || []).forEach(function (s) { present[s] = true; }); });
                (subsystems.length ? subsystems : Object.keys(present)).forEach(function (s) {
                    if (!present[s]) return;
                    var b = el("button", "al-chip" + (fSubs[s] ? " on" : ""), s); b.type = "button";
                    b.addEventListener("click", function () {
                        if (fSubs[s]) delete fSubs[s]; else fSubs[s] = true;
                        drawSubs(); rebuildCseOptions();
                    });
                    subRow.appendChild(b);
                });
            }
            cse.addEventListener("change", listCse);
            osSel.addEventListener("change", function () { fOs = osSel.value; rebuildCseOptions(); });
            setBtn.addEventListener("click", function () {
                if (!cse.value) { msg.textContent = " pick a CSE"; return; }
                setBtn.disabled = true; msg.textContent = " setting…";
                run("gpo-pref-set", { gpo: gpo, cse: cse.value, entry: entry.value, value: value.value })
                    .then(function () { setBtn.disabled = false; msg.textContent = " set"; listCse(); })
                    .catch(function (e) { setBtn.disabled = false; msg.textContent = " " + e; });
            });

            // Populate the CSE set + facets from the catalog (override-aware).
            // source=cse skips the ADMX parse — the full catalog is thousands of
            // policies / tens of seconds, and this modal only needs the CSEs.
            run("gpo-catalog", { source: "cse" }).then(function (r) {
                osTypes = r.os_types || [];
                subsystems = r.subsystems || [];
                cses = (r.entries || []).filter(function (e) { return e.source === "cse"; })
                    .map(function (e) { return { cse: e.cse, name: e.name, os_type: e.os_type, subsystems: e.subsystems || [] }; });
                osTypes.forEach(function (o) { var op = el("option", null, o); op.value = o; osSel.appendChild(op); });
                drawSubs(); rebuildCseOptions();
            }).catch(function () {
                cses = CSE_FALLBACK.map(function (c) { return { cse: c, name: c, os_type: "", subsystems: [] }; });
                matchHint.textContent = "(catalog unavailable — showing all preference types)";
                rebuildCseOptions();
            });
        });
    }

    function gpoDetailModal(gpo) {
        if (!gpo) { return; }
        modal("GPO settings", function (box) {
            box.appendChild(el("div", "hint", "GPO: ")).appendChild(el("kbd", "al", gpo));
            var out = el("div"); out.appendChild(el("div", "al-loading", "loading…"));
            run("gpo-show", { gpo: gpo }).then(function (r) {
                clear(out);
                var meta = r.meta || {};
                out.appendChild(tableOf(["field", "value"], Object.keys(meta).map(function (k) { return [k, meta[k]]; })));
                if ((r.links || []).length) {
                    var lc = card("Linked containers");
                    lc.appendChild(tableOf(["DN"], r.links.map(function (l) { return [l]; })));
                    out.appendChild(lc);
                }
                var sc = card("Administrative-Template (registry) settings");
                if (!(r.settings || []).length) sc.appendChild(el("div", "hint", "(none)"));
                else sc.appendChild(tableOf(["class", "key", "value", "type", "data"],
                    r.settings.map(function (s) {
                        return [s.class, s.keyname, s.valuename, s.type, String(s.data)];
                    })));
                out.appendChild(sc);
                var editBtn = el("button", "al-btn", "edit policies");
                editBtn.addEventListener("click", function () { openModal("gpo-edit", { target: gpo }); });
                out.appendChild(editBtn);
            }).catch(function (e) { clear(out); out.appendChild(el("div", "al-alert err", String(e))); });
            box.appendChild(out);
            var close = el("button", "al-btn secondary", "Close");
            close.addEventListener("click", closeModal); box.appendChild(close);
        });
    }

    // --------------------------------------------------- sites/replication
    function renderSites() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Run KCC now (all DCs)", "repl-now", {}, ""));
        acts.appendChild(actionButton("Sync SYSVOL", "sysvol-sync", {}));
        acts.appendChild(actionButton("sysvolcheck", "sysvolcheck", {}));
        m.appendChild(acts);
        var grid = el("div", "al-grid"); m.appendChild(grid);
        run("sites-list").then(function (r) {
            var c = card("Sites & subnets");
            c.appendChild(tableOf(["site"], r.sites.map(function (s) { return [s]; })));
            if (r.subnets.length)
                c.appendChild(tableOf(["subnet", "site"], r.subnets.map(function (s) { return [s.subnet, s.site]; })));
            grid.appendChild(c);
        }).catch(function (e) { grid.appendChild(failCard("Sites", e)); });
        run("repl-status").then(function (r) {
            var c = card("Replication neighbors", true);
            var rows = [];
            r.replication.forEach(function (d) {
                (d.neighbors || []).forEach(function (n) {
                    rows.push([d.dc, n.direction, n.partner, n.nc,
                               badge(n.ok ? "healthy" : n.consecutive_failures + " failures", n.ok ? "ok" : "err")]);
                });
                if (d.error) rows.push([d.dc, "", "", "", badge(d.error, "err")]);
            });
            c.appendChild(tableOf(["DC", "dir", "partner", "naming context", "state"], rows));
            grid.appendChild(c);
        }).catch(function (e) { grid.appendChild(failCard("Replication", e)); });
    }

    // ----------------------------------------------------------------- dns
    function renderDns() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Add record", "dns-add", {}, ""));
        acts.appendChild(actionButton("Delete record", "dns-delete", {}));
        m.appendChild(acts);
        var holder = el("div"); m.appendChild(holder);
        run("dns-zones").then(function (r) {
            var c = card("Zones on " + r.server, true); holder.appendChild(c);
            var sel = el("select");
            r.zones.forEach(function (z) { var o = el("option", null, z); o.value = z; sel.appendChild(o); });
            sel.style.maxWidth = "320px"; c.appendChild(sel);
            var recHolder = el("div"); c.appendChild(recHolder);
            function loadZone() {
                clear(recHolder); recHolder.appendChild(el("div", "al-loading", "loading records…"));
                run("dns-records", { zone: sel.value }).then(function (rr) {
                    clear(recHolder);
                    recHolder.appendChild(tableOf(["name", "type", "data", "ttl"],
                        rr.records.map(function (x) { return [x.name, badge(x.type), x.data, x.ttl]; })));
                }).catch(function (e) { clear(recHolder); recHolder.appendChild(el("div", "al-alert err", String(e))); });
            }
            sel.addEventListener("change", loadZone); loadZone();
        }).catch(function (e) { holder.appendChild(failCard("DNS", e)); });
    }

    // ------------------------------------------------------------- domains
    // Multi-forest lifecycle: every independent domain in the lab, primary
    // first. "Add domain" provisions a NEW forest (its own podman network + a
    // first DC); each additional forest can be backed up or removed whole.
    // Per-DC promote/decommission lives on the DCs tab, scoped by the selector.
    /* Run a verb scoped to a specific forest without disturbing the global
     * selector. run() builds its argv synchronously from currentDomain, so a
     * save/restore around the call is safe. realm null = the primary forest. */
    function runIn(realm, verb, args, stdin) {
        var saved = currentDomain;
        currentDomain = realm || null;
        try { return run(verb, args, stdin); }
        finally { currentDomain = saved; }
    }

    /* Confirm, then promote a new replication-partner DC into one forest. Used
     * by the per-domain "Add DC" action and the DCs-tab "Promote new DC". */
    function promoteDcPrompt(realm, label) {
        transientModal("Add a DC to " + label, function (b, close) {
            b.appendChild(el("div", "hint",
                "Promotes a new replication-partner DC into " + label + ". The join "
                + "runs in the background — watch it with the DC's “logs”. The new "
                + "DC's ordinal and IP are chosen automatically."));
            var alertBox = el("div", "al-alert err");
            var row = el("div", "row");
            var go = el("button", "al-btn", "Add DC");
            var cancel = el("button", "al-btn secondary", "Cancel");
            cancel.addEventListener("click", close);
            go.addEventListener("click", function () {
                go.disabled = true; alertBox.textContent = "";
                runIn(realm, "dc-promote", {}).then(function (res) {
                    close();
                    transientModal("Promoting a DC", function (bb, cc) {
                        bb.appendChild(el("pre", "al-log", JSON.stringify(res, null, 2)));
                        var ok = el("button", "al-btn", "Close");
                        ok.addEventListener("click", cc); bb.appendChild(ok);
                    });
                    refreshTab();
                }).catch(function (e) { go.disabled = false; alertBox.textContent = String(e); });
            });
            row.appendChild(go); row.appendChild(cancel);
            b.appendChild(alertBox); b.appendChild(row);
        });
    }

    function renderDomains() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Add domain", "domain-add", {}, ""));
        m.appendChild(acts);
        m.appendChild(el("div", "hint",
            "Each domain is a Samba forest on its own podman network. Adding a domain "
            + "deploys its first (provisioning) DC. Specify a parent to place the new "
            + "domain on the parent's network and join the parent's forest via a trust — "
            + "samba AD has no in-forest child domains, so the parent link is a forest "
            + "trust (use “Create trust” after it provisions). Removing a domain tears "
            + "down all of its DCs and its network (optionally backing up first)."));
        var holder = el("div", "al-grid"); m.appendChild(holder);
        loadDomains().then(function (domains) {
            if (!domains.length) { holder.appendChild(failCard("Domains", "no forests found")); return; }
            domains.forEach(function (d) {
                var c = card(d.realm, true);
                var head = el("div", "al-actions");
                head.appendChild(badge(d.primary ? "primary" : "additional", d.primary ? "ok" : "dim"));
                head.appendChild(badge("NetBIOS " + d.domain_nb));
                head.appendChild(badge("net " + d.net));
                if (d.net_prefix) head.appendChild(badge(d.net_prefix + ".0/24"));
                if (d.parent) head.appendChild(badge("parent " + d.parent, "warn"));
                head.appendChild(badge(d.dc_count + " DC" + (d.dc_count === 1 ? "" : "s"),
                                       d.dc_count ? "ok" : "warn"));
                c.appendChild(head);
                c.appendChild(tableOf(["DC", "ip", "state"], (d.dcs || []).map(function (x) {
                    return [x.name, x.ip || "—", badge(x.state, x.state === "running" ? "ok" : "err")];
                })));
                var box = el("div", "al-actions");
                var manage = el("button", "al-btn secondary", "Manage DCs");
                manage.addEventListener("click", function () {
                    currentDomain = d.primary ? null : d.realm;   // goTab carries it in the URL
                    goTab("dcs");
                });
                box.appendChild(manage);
                var addDc = el("button", "al-btn", "Add DC");
                addDc.addEventListener("click", function () {
                    promoteDcPrompt(d.primary ? null : d.realm, d.realm);
                });
                box.appendChild(addDc);
                box.appendChild(actionButton("Back up", "domain-backup", { realm: d.realm }));
                var trustsBtn = el("button", "al-btn secondary", "Trusts");
                trustsBtn.addEventListener("click", function () {
                    run("domain-trust-list", { realm: d.realm }).then(function (r) {
                        transientModal("Trusts of " + d.realm, function (b, close) {
                            if (!(r.trusts || []).length) b.appendChild(el("div", "hint", "no trusts"));
                            else b.appendChild(tableOf(["name", "type", "direction", "transitive"],
                                r.trusts.map(function (t) { return [t.name, t.type, t.direction, t.transitive]; })));
                            var ok = el("button", "al-btn", "Close");
                            ok.addEventListener("click", close); b.appendChild(ok);
                        });
                    }).catch(function (e) {
                        transientModal("trust-list failed", function (b, close) {
                            b.appendChild(el("div", "al-alert err", String(e)));
                            var ok = el("button", "al-btn", "Close");
                            ok.addEventListener("click", close); b.appendChild(ok);
                        });
                    });
                });
                box.appendChild(trustsBtn);
                box.appendChild(actionButton("Create trust", "domain-trust-create", { realm: d.realm }));
                if (!d.primary)
                    box.appendChild(actionButton("Remove domain", "domain-remove", { realm: d.realm }, "danger"));
                c.appendChild(box);
                holder.appendChild(c);
            });
        });
    }

    // ----------------------------------------------------------------- dcs
    function renderDcs() {
        var m = content();
        var scope = currentDomain
            ? ("Forest in view: " + currentDomain + " — promotes and decommissions act on this forest.")
            : ("Forest in view: primary (" + (IDENT ? IDENT.realm : "") + ").");
        m.appendChild(el("div", "hint", scope));
        var acts = el("div", "al-actions");
        var promote = el("button", "al-btn", "Promote new DC");
        promote.addEventListener("click", function () {
            promoteDcPrompt(currentDomain, currentDomain || (IDENT ? IDENT.realm : "primary"));
        });
        acts.appendChild(promote);
        acts.appendChild(actionButton("Transfer FSMO role", "fsmo-transfer", {}));
        acts.appendChild(actionButton("Seize FSMO role", "fsmo-seize", {}, "danger"));
        m.appendChild(acts);
        var holder = el("div", "al-grid"); m.appendChild(holder);
        run("dc-list").then(function (r) {
            var c = card("Domain controllers", true);
            c.appendChild(tableOf(["DC", "ip", "state", "FSMO", "actions"], r.dcs.map(function (d) {
                var roles = el("div");
                (d.fsmo_roles || []).forEach(function (x) {
                    roles.appendChild(badge(x.replace("MasterRole", ""), "ok"));
                    roles.appendChild(document.createTextNode(" "));
                });
                var box = el("div", "al-actions");
                [["logs", "dc-logs"], ["processes", "dc-processes"], ["rpc", "dc-rpc"],
                 ["trace level", "dc-debug"], ["shell", "dc-shell"], ["restart", "dc-restart"],
                 ["demote", "dc-demote"], ["decommission", "dc-decommission"]].forEach(function (p) {
                    box.appendChild(actionButton(p[0], p[1], { dc: d.dc }));
                });
                return [d.dc, d.ip, badge(d.state, d.state === "running" ? "ok" : "err"), roles, box];
            })));
            holder.appendChild(c);
        }).catch(function (e) { holder.appendChild(failCard("Domain controllers", e)); });
    }

    // ------------------------------------------------------------- clients
    function renderClients() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Onboard new client", "client-onboard", {}, ""));
        m.appendChild(acts);
        var holder = el("div", "al-grid"); m.appendChild(holder);
        run("client-list").then(function (r) {
            var c = card("Clients", true);
            c.appendChild(tableOf(["client", "ip", "state", "joined", "actions"], r.clients.map(function (x) {
                var box = el("div", "al-actions");
                box.appendChild(actionButton("remove", "client-remove", { name: x.name }));
                return [x.name, x.ip, badge(x.state, x.state === "running" ? "ok" : "err"),
                        badge(x.joined ? "joined" : "not joined", x.joined ? "ok" : "warn"), box];
            })));
            holder.appendChild(c);
        }).catch(function (e) { holder.appendChild(failCard("Clients", e)); });
    }

    // ------------------------------------------------------- member servers
    /* Windows member servers joined by OFFLINE domain join.
     *
     * The blob member-provision returns is a credential: it authenticates one
     * machine account until the join consumes it. It is therefore shown once,
     * in a modal the operator must copy from, and never stored by this page or
     * re-fetchable afterwards -- the same handling as a generated user password.
     */
    function renderMembers() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Provision machine account", "member-provision", {}, ""));
        m.appendChild(acts);

        var intro = el("div", "hint",
            "Offline domain join: the machine account is created here and its provisioning " +
            "blob is consumed by an unattended installer, so no domain credential is ever " +
            "written into an answer file. Paste the blob into the edy netboot deployment's " +
            "odj_blob variable.");
        intro.style.marginBottom = "0.6rem";
        m.appendChild(intro);

        var holder = el("div", "al-grid"); m.appendChild(holder);
        run("member-list").then(function (r) {
            var c = card("Member servers", true);
            if (!r.members || !r.members.length) {
                c.appendChild(el("div", "hint",
                    "No member servers yet. Provision a machine account above, then deploy the " +
                    "machine with that blob."));
            } else {
                c.appendChild(tableOf(
                    ["machine", "joined", "operating system", "dns name", "actions"],
                    r.members.map(function (x) {
                        var box = el("div", "al-actions");
                        box.appendChild(actionButton("verify", "member-verify", { name: x.name }));
                        box.appendChild(actionButton("re-provision", "member-provision",
                                                     { name: x.name, reuse: "yes" }));
                        box.appendChild(actionButton("delete account", "member-deprovision",
                                                     { name: x.name }));
                        return [x.name,
                                /* "provisioned" is not "joined": an account with no
                                 * operatingSystem/dNSHostName was created here and never
                                 * used by a machine. That distinction is the whole point
                                 * of this column. */
                                badge(x.joined ? "joined" : "provisioned only",
                                      x.joined ? "ok" : "warn"),
                                x.os ? (x.os + " " + (x.os_version || "")).trim() : "-",
                                x.dns || "-",
                                box];
                    })));
            }
            holder.appendChild(c);
        }).catch(function (e) { holder.appendChild(failCard("Member servers", e)); });
    }

    // ------------------------------------------------------------ activity
    function renderActivity() {
        var m = content();
        var c = card("API activity — every adlab-admin invocation", true); m.appendChild(c);
        var refresh = el("button", "al-btn secondary", "Refresh"); c.appendChild(refresh);
        var pre = el("pre", "al-log", "loading…"); c.appendChild(pre);
        function load() {
            run("audit-log", { lines: 200 }).then(function (r) {
                pre.textContent = r.entries.length ? r.entries.join("\n") : "(no invocations logged yet)";
                pre.scrollTop = pre.scrollHeight;
            }).catch(function (e) { pre.textContent = String(e); });
        }
        refresh.addEventListener("click", load); load();
    }

    // -------- Crypto control plane (enable/disable encryption per situation)
    function renderCrypto() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Set account etypes", "crypto-account-etypes", {}));
        acts.appendChild(actionButton("Bulk harden", "crypto-harden", {}));
        var refresh = el("button", "al-btn secondary", "Refresh");
        refresh.addEventListener("click", function () { refreshTab(); });
        acts.appendChild(refresh);
        m.appendChild(acts);
        m.appendChild(el("div", "al-alert warn",
            "Enable or disable encryption per situation. Kerberos account encryption " +
            "types are set live in the directory; “Bulk harden” applies a preset (e.g. " +
            "AES-only) across a filter — dry-run first. Server crypto (SMB / NTLM / " +
            "LDAP-TLS / schannel) writes smb.conf and reloads; some settings only take " +
            "effect after a DC restart, and a wrong value can break authentication."));
        var holder = el("div", "al-grid"); m.appendChild(holder);
        var fAcc = slotCard(holder, "Kerberos account encryption", true);
        var fSrv = slotCard(holder, "Server crypto settings", true);
        run("crypto-catalog").then(function (r) {
            var acc = r.kerberos_accounts;
            var box = el("div");
            box.appendChild(el("div", "al-sub",
                "On " + r.on + ": " + acc.total + " accounts — " + acc.rc4_allowed +
                " RC4-allowed, " + acc.aes_only + " AES-only, " + acc.rc4_spn_users +
                " RC4 SPN user account(s) (prime Kerberoast targets)."));
            var arow = el("div", "al-actions");
            arow.appendChild(actionButton("Harden SPN users → AES-only", "crypto-harden",
                { scope: "spn-users", preset: "aes-only" }));
            arow.appendChild(actionButton("Set one account", "crypto-account-etypes", {}));
            box.appendChild(arow);
            fAcc(box, "Kerberos account encryption posture");

            var bySit = {};
            r.server.forEach(function (s) { (bySit[s.situation] = bySit[s.situation] || []).push(s); });
            var sbox = el("div");
            Object.keys(bySit).sort().forEach(function (sit) {
                sbox.appendChild(el("h4", null, sit));
                sbox.appendChild(emptyOr(bySit[sit],
                    ["setting", "current", "recommended", "status", "set"],
                    function (s) {
                        var ctl;
                        if ((s.choices || []).length) {
                            ctl = el("select");
                            s.choices.forEach(function (c) {
                                var o = el("option", null, c); o.value = c;
                                if (c === s.value) o.selected = true;
                                ctl.appendChild(o);
                            });
                        } else {
                            ctl = el("input"); ctl.type = "text"; ctl.value = s.value || "";
                        }
                        var apply = el("button", "al-btn", "apply");
                        apply.addEventListener("click", function () {
                            apply.disabled = true;
                            run("crypto-set", { id: s.id, value: ctl.value }).then(function () {
                                refreshTab();
                            }).catch(function (e) {
                                apply.disabled = false;
                                transientModal("crypto-set failed", function (b, close) {
                                    b.appendChild(el("div", "al-alert err", String(e)));
                                    var ok = el("button", "al-btn", "Close");
                                    ok.addEventListener("click", close); b.appendChild(ok);
                                });
                            });
                        });
                        var cell = el("div", "al-actions"); cell.appendChild(ctl); cell.appendChild(apply);
                        var status = s.compliant === true ? badge("hardened", "ok")
                            : (s.compliant === false ? badge("review", "warn") : el("span", "hint", "—"));
                        return [s.param, s.value || "(default)", s.recommended || "", status, cell];
                    }, "none"));
            });
            fSrv(sbox, "Server crypto settings (smb.conf; reload/restart to apply)");
        }).catch(function (e) {
            fAcc(el("div", "al-alert err", String(e)));
            fSrv(el("div", "al-alert err", String(e)));
        });
    }

    // -------- Kerberos ticket anomaly detection (Kerberoasting)
    function renderKerberos() {
        var m = content();
        function fmtT(s) { try { return s ? new Date(s * 1000).toLocaleString() : ""; } catch (e) { return String(s); } }
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Enable audit", "kerberos-audit-enable", {}));
        acts.appendChild(actionButton("Disable audit", "kerberos-audit-disable", {}));
        acts.appendChild(actionButton("Ticket requests", "kerberos-ticket-requests", {}));
        var refresh = el("button", "al-btn secondary", "Refresh");
        refresh.addEventListener("click", function () { refreshTab(); });
        acts.appendChild(refresh);
        m.appendChild(acts);
        m.appendChild(el("div", "al-alert warn",
            "Detects Kerberoasting: service tickets requested/issued with RC4 (etype " +
            "0x17) instead of AES — RC4 hashes crack far faster — and accounts pulling " +
            "many TGS tickets for distinct SPNs in a short window (a roasting sweep). " +
            "Live detection needs KDC auditing ON (Enable audit — runtime; resets on a " +
            "DC restart). The exposure table below is always available."));
        var holder = el("div", "al-grid"); m.appendChild(holder);

        var fAnom = slotCard(holder, "Anomalous ticket requests", true);
        run("kerberos-anomalies", { window: 60 }).then(function (r) {
            var box = el("div");
            if (!r.audit_active)
                box.appendChild(el("div", "al-alert warn",
                    "KDC auditing is OFF — click “Enable audit”, then generate or await " +
                    "Kerberos traffic. Showing " + r.considered + " live events."));
            box.appendChild(el("h4", null, "RC4 downgrade requests — " + r.rc4_count));
            box.appendChild(emptyOr(r.rc4_requests,
                ["time", "client", "target SPN", "requested", "issued", "source"],
                function (x) {
                    return [fmtT(x.time), x.client, x.spn,
                            (x.requested_etypes || []).join(", "),
                            x.rc4_issued ? badge(String(x.issued_etype), "err") : String(x.issued_etype),
                            x.ip];
                }, "no RC4 requests in window"));
            box.appendChild(el("h4", null, "Bulk TGS — possible sweep — " + r.bulk_count));
            box.appendChild(emptyOr(r.bulk_tgs,
                ["client", "TGS", "distinct SPNs", "RC4?", "SPNs"],
                function (x) {
                    return [el("kbd", "al", x.client), String(x.tgs_count),
                            String(x.distinct_spns),
                            x.rc4_any ? badge("yes", "err") : badge("no", "dim"),
                            (x.spns || []).join("  ")];
                }, "no bulk-TGS accounts in window"));
            fAnom(box, "Anomalous ticket requests (last " + r.window_minutes + " min; flag ≥ " +
                r.distinct_spn_threshold + " distinct SPNs or ≥ " + r.tgs_threshold + " TGS/account)");
        }).catch(function (e) { fAnom(el("div", "al-alert err", String(e))); });

        var fExp = slotCard(holder, "Kerberoast exposure", true);
        run("kerberos-roast-exposure").then(function (r) {
            fExp(emptyOr(r.accounts,
                ["account", "type", "#SPN", "supported etypes", "exposure"],
                function (x) {
                    return [el("kbd", "al", x.account), x.class, String(x.spn_count),
                            (x.supported_etypes || []).join(", ") || "(unset → RC4)",
                            x.aes_only ? badge("AES-only", "ok") : badge("RC4 roastable", "err")];
                }, "no SPN accounts"),
                "Kerberoast exposure — " + r.roastable + "/" + r.total + " roastable (" +
                r.roastable_users + " user account(s)); harden to AES-only (0x18). On " + r.on);
        }).catch(function (e) { fExp(el("div", "al-alert err", String(e))); });

        var fSt = slotCard(holder, "KDC audit status", true);
        run("kerberos-audit-status").then(function (r) {
            fSt(emptyOr(r.dcs, ["DC", "kerberos level", "auditing", "records"], function (x) {
                return [x.dc, String(x.kerberos_level),
                        x.audit_active ? badge("on", "ok") : badge("off", "dim"),
                        String(x.tgs_records)];
            }, "no DCs"), "KDC audit status (auditing is runtime — resets on a DC restart)");
        }).catch(function (e) { fSt(el("div", "al-alert err", String(e))); });
    }

    // -------- SPNs (Service Principal Names) — setspn-compatible control plane
    function renderSpn() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Add SPN", "spn-add", {}, ""));
        acts.appendChild(actionButton("Query SPN", "spn-query", {}));
        acts.appendChild(actionButton("Find duplicates", "spn-find-duplicates", {}));
        var refresh = el("button", "al-btn secondary", "Refresh");
        refresh.addEventListener("click", function () { refreshTab(); });
        acts.appendChild(refresh);
        m.appendChild(acts);
        m.appendChild(el("div", "al-alert warn",
            "A Service Principal Name binds a Kerberos service to the account that runs it. " +
            "These map to Windows setspn: Add SPN = setspn -S (add, refuses a duplicate; " +
            "force = -A), the ✕ next to an SPN = setspn -D, Query SPN = setspn -Q, " +
            "Find duplicates = setspn -X. Writes land on the PDC emulator. The SAME SPN on " +
            "two accounts breaks Kerberos for that service — Find duplicates surfaces those."));
        var holder = el("div", "al-grid"); m.appendChild(holder);
        var fSpn = slotCard(holder, "Accounts with SPNs", true);
        run("spn-list-all").then(function (r) {
            var title = "Accounts with SPNs — " + r.account_count + " account(s), " +
                        r.spn_count + " SPN(s) (on " + r.on + ")";
            fSpn(emptyOr(r.accounts, ["account", "type", "#", "servicePrincipalName", ""],
                function (a) {
                    var spnCell = el("div", "al-spnlist");
                    a.spns.forEach(function (s) {
                        var line = el("div", "al-spnrow");
                        line.appendChild(el("code", "al-spn", s));
                        line.appendChild(actionButton("✕", "spn-delete",
                            { account: a.account, spn: s }));
                        spnCell.appendChild(line);
                    });
                    var addBox = el("div", "al-actions");
                    addBox.appendChild(actionButton("+ SPN", "spn-add", { account: a.account }));
                    return [el("kbd", "al", a.account),
                            badge(a["class"] === "computer" ? "computer" : "user", "dim"),
                            String(a.spns.length), spnCell, addBox];
                }, "no account carries an SPN"), title);
        }).catch(function (e) { fSpn(el("div", "al-alert err", String(e))); });
    }

    // -------- AD PKI: CA node + domain-integrated templates + issuance
    function renderPki() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Deploy CA node", "pki-ca-deploy", {}));
        acts.appendChild(actionButton("Publish to AD", "pki-ca-publish", {}));
        acts.appendChild(actionButton("Seed templates", "pki-template-seed", {}));
        acts.appendChild(actionButton("Issue certificate", "pki-issue", {}));
        var refresh = el("button", "al-btn secondary", "Refresh");
        refresh.addEventListener("click", function () { refreshTab(); });
        acts.appendChild(refresh);
        m.appendChild(acts);
        m.appendChild(el("div", "al-alert warn",
            "A domain-integrated PKI. The CA node is a dedicated openssl-CA container " +
            "with its own self-signed root; “Publish to AD” writes the root into the " +
            "forest (Certification Authorities root-trust, AIA, NTAuthCertificates for " +
            "cert logon, and an Enrollment Service) so members trust it. Templates are " +
            "real pKICertificateTemplate objects. Issuance is manual (Issue certificate) " +
            "— openssl signs a leaf per the chosen template. Directory writes land on the PDC."));
        var holder = el("div", "al-grid"); m.appendChild(holder);

        var fCa = slotCard(holder, "Certificate Authority node", true);
        var fAd = slotCard(holder, "AD registration", true);
        run("pki-status").then(function (r) {
            var ca = r.ca_node || {}, ad = r.ad || {};
            // ---- CA node card
            var box = el("div");
            if (!ca.deployed) {
                box.appendChild(el("div", "al-alert warn",
                    "No CA node deployed. Click “Deploy CA node” to create the openssl-CA " +
                    "container and generate a self-signed Enterprise Root CA."));
            } else if (!ca.root_ca) {
                box.appendChild(el("div", "al-alert warn",
                    "CA node container is up but has no root CA yet — re-run Deploy CA node."));
            } else {
                box.appendChild(emptyOr([
                    { k: "CA node", v: badge("running", "ok") },
                    { k: "Root CA", v: el("code", "al-spn", ca.cert || "(unknown)") },
                    { k: "Issued certs", v: String(ca.issued != null ? ca.issued : 0) }
                ], ["property", "value"], function (x) { return [x.k, x.v]; }, "none"));
                var arow = el("div", "al-actions");
                arow.appendChild(actionButton("CA detail", "pki-ca-status", {}));
                arow.appendChild(actionButton("Destroy CA node", "pki-ca-destroy", {}));
                box.appendChild(arow);
            }
            fCa(box, "Certificate Authority node");
            // ---- AD registration card
            function mk(label, ok) {
                var row = el("div", "al-spnrow");
                row.appendChild(el("span", null, label));
                row.appendChild(ok ? badge("published", "ok") : badge("not published", "dim"));
                return row;
            }
            var abox = el("div");
            abox.appendChild(mk("Root trust (Certification Authorities)", ad.root_trust));
            abox.appendChild(mk("AIA (chain)", ad.aia));
            abox.appendChild(mk("NTAuthCertificates (cert logon)", ad.ntauth));
            abox.appendChild(mk("Enrollment Service", ad.enrollment_service));
            abox.appendChild(el("div", "al-sub", (ad.templates || 0) + " certificate template(s) in AD."));
            var ar = el("div", "al-actions");
            ar.appendChild(actionButton("Publish to AD", "pki-ca-publish", {}));
            ar.appendChild(actionButton("List NTAuth CAs", "pki-ntauth-list", {}));
            ar.appendChild(actionButton("Unpublish", "pki-ca-unpublish", {}));
            abox.appendChild(ar);
            fAd(abox, "AD registration (Public Key Services, on " + (r.pdc || "the PDC") + ")");
        }).catch(function (e) {
            fCa(el("div", "al-alert err", String(e)));
            fAd(el("div", "al-alert err", String(e)));
        });

        var fTpl = slotCard(holder, "Certificate templates", true);
        run("pki-template-list").then(function (r) {
            var box = el("div");
            box.appendChild(el("h4", null, "In AD (" + (r.live || []).length + ")"));
            box.appendChild(emptyOr(r.live, ["template", "display", "schema", "EKU", ""],
                function (t) {
                    return [el("kbd", "al", t.cn), t.display || "", "v" + (t.schema_version || "?"),
                            (t.eku || []).join(", "),
                            actionButton("✕", "pki-template-delete", { name: t.cn })];
                }, "no templates seeded yet — use “Seed templates”"));
            box.appendChild(el("h4", null, "Standard set (seedable)"));
            box.appendChild(emptyOr(r.catalog, ["template", "purpose", "key", "days", ""],
                function (c) {
                    return [c.display, c.purpose, String(c.key), String(c.days),
                            actionButton("Seed", "pki-template-seed", { name: c.name })];
                }, "none"));
            fTpl(box, "Certificate templates (pKICertificateTemplate) — " + (r.templates_dn || ""));
        }).catch(function (e) { fTpl(el("div", "al-alert err", String(e))); });

        var fCerts = slotCard(holder, "Issued certificates", true);
        run("pki-cert-list").then(function (r) {
            fCerts(emptyOr(r.certs, ["file", "subject", "expires", "serial"],
                function (c) {
                    return [el("code", "al-spn", c.file), c.subject, c.not_after, c.serial];
                }, "no certificates issued yet"),
                "Issued certificates — " + (r.count || 0) + " (on " + (r.ca_node || "CA node") + ")");
        }).catch(function (e) { fCerts(el("div", "al-alert err", String(e))); });
    }

    // -------- S4U / delegation + authentication policies
    function renderDelegation() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Add constrained service", "delegation-add-service", {}));
        acts.appendChild(actionButton("Grant RBCD", "rbcd-add", {}));
        acts.appendChild(actionButton("Set unconstrained", "delegation-set-unconstrained", {}));
        var refresh = el("button", "al-btn secondary", "Refresh");
        refresh.addEventListener("click", function () { refreshTab(); });
        acts.appendChild(refresh);
        m.appendChild(acts);
        m.appendChild(el("div", "al-alert warn",
            "Kerberos delegation (S4U) and authentication hardening. Three delegation " +
            "types: unconstrained (TRUSTED_FOR_DELEGATION — a compromise of that host " +
            "impersonates anyone; DCs hold it by design), constrained " +
            "(msDS-AllowedToDelegateTo, + protocol transition = S4U2Proxy), and " +
            "resource-based (RBCD — the target names who may impersonate to it). Harden " +
            "with the Protected Users group and authentication policies / silos. Writes " +
            "land on the PDC emulator."));
        var holder = el("div", "al-grid"); m.appendChild(holder);

        function riskBadge(r) {
            return r === "high" ? badge("high", "err")
                 : r === "medium" ? badge("review", "warn") : badge("low", "dim");
        }
        var fInv = slotCard(holder, "Delegation inventory", true);
        run("delegation-list").then(function (r) {
            fInv(emptyOr(r.accounts, ["account", "type", "kinds", "delegates to", "risk", ""],
                function (x) {
                    var actbox = el("div", "al-actions");
                    actbox.appendChild(actionButton("show", "delegation-show", { account: x.account }));
                    if (x.rbcd) actbox.appendChild(actionButton("RBCD", "rbcd-show", { account: x.account }));
                    return [el("kbd", "al", x.account),
                            badge(x["class"] === "computer" ? "computer" : "user", "dim"),
                            (x.kinds || []).join(", "),
                            (x.allowed_to || []).join("  ") || "—",
                            riskBadge(x.risk), actbox];
                }, "no account has delegation configured"),
                "Delegation inventory — " + (r.count || 0) + " account(s) (on " + (r.on || "") + ")");
        }).catch(function (e) { fInv(el("div", "al-alert err", String(e))); });

        var fProt = slotCard(holder, "Protected Users", true);
        run("protected-users-list").then(function (r) {
            var box = el("div");
            box.appendChild(el("div", "al-sub",
                "Members get hardened credentials: no NTLM/DES/RC4, no delegation, short TGT."));
            var arow = el("div", "al-actions");
            arow.appendChild(actionButton("Add member", "protected-users-add", {}));
            box.appendChild(arow);
            box.appendChild(emptyOr((r.members || []).map(function (dn) { return { dn: dn }; }),
                ["member DN", ""], function (x) {
                    return [el("code", "al-spn", x.dn),
                            actionButton("✕", "protected-users-remove", { member: x.dn })];
                }, "no members"));
            fProt(box, "Protected Users — " + (r.count || 0) + " member(s)");
        }).catch(function (e) { fProt(el("div", "al-alert err", String(e))); });

        var fPol = slotCard(holder, "Authentication policies & silos", true);
        Promise.all([run("authpolicy-list").catch(function () { return { policies: [] }; }),
                     run("authsilo-list").catch(function () { return { silos: [] }; })])
            .then(function (rs) {
                var box = el("div");
                box.appendChild(el("div", "al-alert warn",
                    "Create policies audit-first (enforce off); enforcement is by samba's " +
                    "KDC for accounts in an assigned silo or with the policy set directly."));
                var arow = el("div", "al-actions");
                arow.appendChild(actionButton("New policy", "authpolicy-create", {}));
                arow.appendChild(actionButton("New silo", "authsilo-create", {}));
                box.appendChild(arow);
                box.appendChild(el("h4", null, "Policies (" + (rs[0].policies || []).length + ")"));
                box.appendChild(emptyOr((rs[0].policies || []).map(function (n) { return { n: n }; }),
                    ["policy", ""], function (x) {
                        var b = el("div", "al-actions");
                        b.appendChild(actionButton("view", "authpolicy-show", { name: x.n }));
                        b.appendChild(actionButton("✕", "authpolicy-delete", { name: x.n }));
                        return [el("kbd", "al", x.n), b];
                    }, "no authentication policies"));
                box.appendChild(el("h4", null, "Silos (" + (rs[1].silos || []).length + ")"));
                box.appendChild(emptyOr((rs[1].silos || []).map(function (n) { return { n: n }; }),
                    ["silo", ""], function (x) {
                        var b = el("div", "al-actions");
                        b.appendChild(actionButton("view", "authsilo-show", { name: x.n }));
                        b.appendChild(actionButton("grant", "authsilo-member-grant", { name: x.n }));
                        b.appendChild(actionButton("✕", "authsilo-delete", { name: x.n }));
                        return [el("kbd", "al", x.n), b];
                    }, "no authentication silos"));
                fPol(box, "Authentication policies & silos");
            }).catch(function (e) { fPol(el("div", "al-alert err", String(e))); });
    }

    // ---------------------------------------------------------------- boot
    var RENDER = { overview: renderOverview,
                   objects: renderObjects, spn: renderSpn, kerberos: renderKerberos,
                   crypto: renderCrypto, pki: renderPki, delegation: renderDelegation,
                   gpo: renderGpo,
                   sites: renderSites, dns: renderDns, domains: renderDomains,
                   dcs: renderDcs, clients: renderClients, members: renderMembers,
                   activity: renderActivity };

    function boot() {
        renderTabs();
        run("schema").then(function (s) {
            SCHEMA = s;
            return run("version");
        }).then(function (v) {
            IDENT = v;
            document.getElementById("al-identity").textContent =
                v.realm + " — " + v.domain + " (helper v" + v.version + ")";
            cockpit.addEventListener("locationchanged", route);
            document.addEventListener("keydown", function (e) {
                if (e.key === "Escape" && shownStack.length) closeModal();   // pop the top modal
            });
            loadDomains();   // populate the header forest selector (best-effort)
            // Warm the ADMX catalog cache in the background so the GPO editor's
            // left pane opens instantly later. Differential + persistent, so this
            // is cheap once warm and only does the full parse on a cold host.
            run("gpo-catalog", { refresh: "true" }).catch(function () { /* noop */ });
            route();     // render whatever the URL says (deep-link friendly)
        }).catch(function (e) {
            var m = content();
            m.appendChild(el("div", "al-alert err", String(e)));
            m.appendChild(el("p", null,
                "The AD Lab helper could not be reached. Install it with " +
                "cockpit-adlab/source/install.sh (root), then reload."));
        });
    }

    document.addEventListener("DOMContentLoaded", boot);
})();
