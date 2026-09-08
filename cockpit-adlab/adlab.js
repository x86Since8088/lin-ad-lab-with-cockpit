/* AD Lab — Cockpit dashboard for the samba-ad-lab DC fleet.
 *
 * Models the classic AD consoles against the containerized lab:
 *   Users & Groups  = dsa.msc          Group Policy = gpmc.msc
 *   Sites & Repl    = dssite.msc       DNS          = dnsmgmt.msc
 *   Domain Controllers = promotion/demotion, logs, tracing, RPC, remoting
 *   Clients         = onboarding       Activity     = the API audit plane
 *
 * Navigation is URL-driven via cockpit.location: the tab lives in the path
 * (#/gpo) and an open modal lives in the options (?modal=gpo-compose&target=…),
 * so tabs AND modals are deep-linkable and the browser Back/Forward buttons
 * move through them. cockpit.location.go() is the ONLY way state changes; the
 * router (route()) is the single place that renders from it.
 *
 * ALL privileged work goes through ONE root verb helper
 * (/usr/local/sbin/adlab-admin) via cockpit.spawn with superuser:"require".
 * The helper's `schema` verb returns its verb table and generic forms are
 * built from it; the Group Policy compose/ADMX/preferences modals are
 * hand-built on top of the dedicated gpo-* verbs.
 */
(function () {
    "use strict";

    var HELPER = "/usr/local/sbin/adlab-admin";
    var SCHEMA = null;
    var IDENT = null;
    var currentTab = "overview";
    var lastRenderedTab = null;
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
        var argv = [HELPER, verb];
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
    function goTab(tab) { nav([tab]); }

    /* The modal STACK lives in the URL as parallel arrays: each open modal is
     * a (modal, target) pair, so the URL reads
     *   #/gpo?modal=gpo-edit&target={GUID}&modal=gpo-compose&target={GUID}
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
        if (!stack.length) { nav([currentTab], {}); return; }
        nav([currentTab], { modal: stack.map(function (s) { return s.modal; }),
                            target: stack.map(function (s) { return s.target; }) });
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
        if (tab !== lastRenderedTab) {
            lastRenderedTab = tab;
            renderTabs();
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
        if (SCHEMA && SCHEMA.verbs && SCHEMA.verbs[key]) {
            var presets = {};
            try { presets = JSON.parse(target || "{}"); } catch (e) { presets = {}; }
            verbForm(key, presets);
            return;
        }
        switch (key) {
            case "gpo-compose":   gpoComposeModal(target); break;
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
    function modal(title, bodyBuilder, wide) {
        var host = document.getElementById("al-modal-host");
        var back = el("div", "al-backdrop");
        back.style.zIndex = String(50 + host.children.length * 2);
        var box = el("div", "al-modal" + (wide ? " wide" : ""));
        var h2 = el("h2", null, title); box.appendChild(h2);
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
    function transientModal(title, bodyBuilder) {
        var host = document.getElementById("al-modal-host");
        var back = el("div", "al-backdrop");
        back.style.zIndex = String(400 + host.children.length * 2);
        var box = el("div", "al-modal");
        var h2 = el("h2", null, title); box.appendChild(h2);
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
    function fillResult(box, title, res) {
        clear(box);
        box.appendChild(el("h2", null, title));
        if (res && res.password) {
            var w = el("div", "al-alert warn");
            w.textContent = "Generated password (shown once): ";
            w.appendChild(el("kbd", "al", res.password));
            box.appendChild(w);
        }
        box.appendChild(el("pre", "al-log", JSON.stringify(res, null, 2)));
        var ok = el("button", "al-btn", "Close");
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
                if (a.name in presets) return;
                var lab = el("label", null, a.name + (a.required ? "" : " (optional)"));
                if (a.help) lab.appendChild(el("span", "hint", " — " + a.help));
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
            var needTyped = ["fsmo-seize", "dc-demote", "user-delete", "gpo-delete",
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
                Object.keys(presets).forEach(function (k) { args[k] = presets[k]; });
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
                    fillResult(box, verb, res);
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
        ["objects", "Users & Computers"],
        ["gpo", "Group Policy"], ["sites", "Sites & Replication"],
        ["dns", "DNS"], ["dcs", "Domain Controllers"],
        ["clients", "Clients"], ["activity", "Activity"],
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

    function content() {
        var m = document.getElementById("al-content");
        clear(m);
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

    var aduc = {
        base: null, classes: null, advanced: false, search: "",
        extraCols: ["description"], selected: null, previewMode: "tabs",
        treeFilter: "", expanded: {}, treeWidth: 300, nodes: [], schemaCache: {},
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
            var lbl = el("span", "al-tree-label wrap", node.name);
            if (node.system) lbl.appendChild(badge("sys", "dim"));
            row.appendChild(lbl);
            row.addEventListener("click", function () {
                aduc.base = dn; aduc.selected = null; drawTree(); loadList(); drawPreview();
            });
            row.addEventListener("contextmenu", function (ev) { ev.preventDefault(); treeNodeMenu(node, ev.clientX, ev.clientY); });
            var tkeb = el("button", "al-kebab", "⋯"); tkeb.type = "button"; tkeb.title = "actions";
            tkeb.addEventListener("click", function (ev) { ev.stopPropagation(); var b = tkeb.getBoundingClientRect(); treeNodeMenu(node, b.right, b.bottom); });
            row.appendChild(tkeb);
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
                aduc.byDn = {}; aduc.nodes.forEach(function (n) { aduc.byDn[n.dn] = n; });
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
        var admxBtn = el("button", "al-btn secondary", "ADMX central store");
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
            "samba CSEs (`gpo manage`); SYSVOL replicates within 5 minutes."));
        var holder = el("div", "al-grid"); m.appendChild(holder);
        var fGpo = slotCard(holder, "Group Policy objects", true);
        run("gpo-list").then(function (r) {
            fGpo(emptyOr(r.gpos, ["GPO", "display name", "ver", "actions"], function (g) {
                var box = el("div", "al-actions");
                var edit = el("button", "al-btn", "edit");
                edit.addEventListener("click", function () { openModal("gpo-edit", { target: g.gpo }); });
                box.appendChild(edit);
                var compose = el("button", "al-btn secondary", "compose");
                compose.addEventListener("click", function () { openModal("gpo-compose", { target: g.gpo }); });
                box.appendChild(compose);
                var detail = el("button", "al-btn secondary", "settings");
                detail.addEventListener("click", function () { openModal("gpo-detail", { target: g.gpo }); });
                box.appendChild(detail);
                var prefs = el("button", "al-btn secondary", "preferences");
                prefs.addEventListener("click", function () { openModal("gpo-prefs", { target: g.gpo }); });
                box.appendChild(prefs);
                box.appendChild(actionButton("backup", "gpo-backup", { gpo: g.gpo }));
                box.appendChild(actionButton("link", "gpo-link", { gpo: g.gpo }));
                box.appendChild(actionButton("unlink", "gpo-unlink", { gpo: g.gpo }));
                box.appendChild(actionButton("delete", "gpo-delete", { gpo: g.gpo }));
                return [el("kbd", "al", g.gpo), g.display_name, g.version, box];
            }, "no GPOs"), "Group Policy objects (on " + r.pdc_emulator + ")");
        }).catch(function (e) { fGpo(el("div", "al-alert err", String(e))); });
    }

    // -------- GPO compose modal: STACK template / ADMX / preference layers
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
    function valueEditor(initialType, initialData) {
        var curType = initialType || "REG_SZ";
        var wrap = el("div", "al-veditor");
        var typePick = pickerTable({
            columns: [{ key: "type", label: "type" }],
            rows: REG_TYPES.map(function (t) { return { type: t }; }),
            mode: "single", rowKey: function (r) { return r.type; },
            selectedKeys: [curType], height: 140,
            onChange: function (sel) { if (sel[0]) { curType = sel[0].type; renderData(); } }
        });
        wrap.appendChild(el("label", null, "type")); wrap.appendChild(typePick.node);
        var dataHost = el("div", "al-vdata"); wrap.appendChild(dataHost);

        // REG_BINARY state
        var binMode = "Hex";
        var binBytes = (curType === "REG_BINARY" && Array.isArray(initialData)) ? initialData.slice() : [];

        function bytesToText(bytes) { return bytes.map(function (b) { return String.fromCharCode(b & 255); }).join(""); }
        function textToBytes(s) { var out = []; for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255); return out; }
        function bytesToHex(bytes) { return bytes.map(function (b) { return ("0" + (b & 255).toString(16)).slice(-2); }).join(" "); }
        function hexToBytes(s) { return (s.match(/[0-9a-fA-F]{2}/g) || []).map(function (h) { return parseInt(h, 16); }); }

        var ta, dwordInput;
        function renderData() {
            clear(dataHost);
            if (curType === "REG_SZ" || curType === "REG_EXPAND_SZ") {
                ta = el("input"); ta.type = "text";
                ta.value = (typeof initialData === "string") ? initialData : "";
                dataHost.appendChild(el("label", null, "value")); dataHost.appendChild(ta);
            } else if (curType === "REG_DWORD" || curType === "REG_QWORD") {
                dwordInput = el("input"); dwordInput.type = "text";
                dwordInput.placeholder = "decimal or 0x…";
                dwordInput.value = (typeof initialData === "number") ? String(initialData) : "";
                dataHost.appendChild(el("label", null, "value (decimal or 0x hex)")); dataHost.appendChild(dwordInput);
            } else if (curType === "REG_MULTI_SZ") {
                ta = el("textarea"); ta.rows = 4;
                ta.value = Array.isArray(initialData) ? initialData.join("\n") : "";
                dataHost.appendChild(el("label", null, "one string per line"));
                dataHost.appendChild(el("div", "hint", "stored null-separated, double-null terminated"));
                dataHost.appendChild(ta);
            } else if (curType === "REG_BINARY") {
                var modeRow = el("div", "al-vmode");
                ["Hex", "Text"].forEach(function (m) {
                    var b = el("button", "al-btn " + (binMode === m ? "" : "secondary"), m);
                    b.type = "button";
                    b.addEventListener("click", function () {
                        // convert current textarea (old mode) -> bytes, switch, re-render
                        binBytes = (binMode === "Hex") ? hexToBytes(ta.value) : textToBytes(ta.value);
                        binMode = m; renderData();
                    });
                    modeRow.appendChild(b);
                });
                dataHost.appendChild(el("label", null, "binary value")); dataHost.appendChild(modeRow);
                ta = el("textarea"); ta.rows = 3;
                ta.value = (binMode === "Hex") ? bytesToHex(binBytes) : bytesToText(binBytes);
                dataHost.appendChild(el("div", "hint", binMode === "Hex" ? "space/comma-separated hex bytes (e.g. 01 ff 00)" : "text — each character is one byte"));
                dataHost.appendChild(ta);
            }
        }
        renderData();

        function getValue() {
            if (curType === "REG_SZ" || curType === "REG_EXPAND_SZ") return { type: curType, data: ta.value };
            if (curType === "REG_DWORD" || curType === "REG_QWORD") {
                var v = (dwordInput.value || "").trim();
                var n = /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v || "0", 10);
                return { type: curType, data: isNaN(n) ? 0 : n };
            }
            if (curType === "REG_MULTI_SZ")
                return { type: curType, data: ta.value.split("\n").map(function (s) { return s.replace(/\r$/, ""); }).filter(function (s) { return s.length; }) };
            if (curType === "REG_BINARY")
                return { type: curType, data: (binMode === "Hex") ? hexToBytes(ta.value) : textToBytes(ta.value) };
            return { type: curType, data: ta ? ta.value : "" };
        }
        return { node: wrap, getValue: getValue };
    }

    /* The Group Policy compose modal — a full registry.pol editor + stacker.
     * On open it AUTO-LOADS the target GPO's current settings into an editable
     * table; sources (template GPOs, ADMX policies, raw registry, preferences)
     * add rows; Apply is surgical (adds/edits merge via gpo load, removed
     * current entries are removed, preferences set via gpo manage). */
    function gpoComposeModal(target) {
        if (!target) { return; }
        var working = [];          // {id, keyname, valuename, class, type, data, origin, dirty}
        var removed = [];          // current entries the user removed
        var prefs = [];            // staged preference ops
        var seq = 0;
        function nid() { return "e" + (seq++); }

        modal("Compose Group Policy", function (box) {
            box.classList.add("wide");   // 4-panel registry.pol editor needs room
            box.appendChild(el("div", "hint", "Target GPO: ")).appendChild(el("kbd", "al", target));

            var regCard = el("div", "al-card");
            regCard.appendChild(el("h3", null, "Registry settings (auto-loaded — edit to stage changes)"));
            var regHost = el("div"); regHost.appendChild(el("div", "al-loading", "loading current settings…"));
            regCard.appendChild(regHost);
            box.appendChild(regCard);

            var stagedCard = el("div", "al-card");
            stagedCard.appendChild(el("h3", null, "Staged preferences (samba CSEs)"));
            var prefHost = el("div"); stagedCard.appendChild(prefHost);
            box.appendChild(stagedCard);

            function drawReg() {
                clear(regHost);
                if (!working.length) { regHost.appendChild(el("div", "hint", "no registry settings — add from the sources below")); return; }
                var picker = pickerTable({
                    columns: [{ key: "class", label: "class" }, { key: "keyname", label: "key" },
                              { key: "valuename", label: "value" }, { key: "type", label: "type" },
                              { key: "_preview", label: "data" }, { key: "_state", label: "" }],
                    rows: working.map(function (e) {
                        return { _e: e, class: e.class, keyname: e.keyname, valuename: e.valuename,
                                 type: e.type, _preview: dataPreview(e.type, e.data),
                                 _state: e.origin === "added" ? "new" : (e.dirty ? "edited" : "") };
                    }),
                    mode: "multi", rowKey: function (r) { return r._e.id; }, height: 240,
                    actions: function (r) {
                        var b = el("button", "al-btn secondary", "edit");
                        b.addEventListener("click", function () { editEntry(r._e); });
                        return b;
                    }
                });
                regHost.appendChild(picker.node);
                var rm = el("button", "al-btn danger", "Remove selected");
                rm.addEventListener("click", function () {
                    picker.selected().forEach(function (r) {
                        var e = r._e;
                        if (e.origin === "current") removed.push(e);
                        working = working.filter(function (x) { return x.id !== e.id; });
                    });
                    drawReg();
                });
                regHost.appendChild(rm);
            }
            function drawPrefs() {
                clear(prefHost);
                if (!prefs.length) { prefHost.appendChild(el("div", "hint", "none staged")); return; }
                prefs.forEach(function (p, i) {
                    var row = el("div", "al-stack-row");
                    row.appendChild(badge("pref", "warn"));
                    row.appendChild(el("span", "al-stack-label", p.cse + " " + (p.entry || "") + " = " + (p.value || "(unset)")));
                    var x = el("button", "al-btn danger", "✕");
                    x.addEventListener("click", function () { prefs.splice(i, 1); drawPrefs(); });
                    row.appendChild(x); prefHost.appendChild(row);
                });
            }

            // Edit a value INLINE (no nested modal) so the composed state —
            // working set, removals, staged prefs — is never lost.
            function editEntry(e) {
                clear(regHost);
                regHost.appendChild(el("div", "hint", "Editing  " + e.class + "  " + e.keyname + "\\" + e.valuename));
                var ve = valueEditor(e.type, e.data);
                regHost.appendChild(ve.node);
                var row = el("div", "row");
                var save = el("button", "al-btn", "Save value");
                save.addEventListener("click", function () {
                    var v = ve.getValue(); e.type = v.type; e.data = v.data;
                    if (e.origin === "current") e.dirty = true;
                    drawReg();
                });
                var back = el("button", "al-btn secondary", "Cancel");
                back.addEventListener("click", drawReg);
                row.appendChild(save); row.appendChild(back); regHost.appendChild(row);
            }

            // ---- source panels (filterable picker tables) ------------------
            box.appendChild(sourceTemplate());
            box.appendChild(sourceAdmx());
            box.appendChild(sourceRaw());
            box.appendChild(sourcePref());

            var alertBox = el("div", "al-alert err"); box.appendChild(alertBox);
            var rowb = el("div", "row");
            var apply = el("button", "al-btn", "Apply to GPO");
            apply.addEventListener("click", function () {
                alertBox.textContent = "";
                var applyList = working.filter(function (e) { return e.origin === "added" || e.dirty; })
                    .map(function (e) { return { keyname: e.keyname, valuename: e.valuename, class: e.class, type: e.type, data: e.data }; });
                var removeList = removed.map(function (e) { return { keyname: e.keyname, valuename: e.valuename, class: e.class }; });
                if (!applyList.length && !removeList.length && !prefs.length) {
                    alertBox.textContent = "Nothing to apply — edit, add, or remove a setting first."; return;
                }
                apply.disabled = true;
                applyCompose(target, applyList, removeList, prefs).then(function (results) {
                    clear(box);
                    box.appendChild(el("h2", null, "Applied to GPO"));
                    box.appendChild(el("pre", "al-log", JSON.stringify(results, null, 2)));
                    var ok = el("button", "al-btn", "Close");
                    ok.addEventListener("click", function () { closeModal(); refreshTab(); });
                    box.appendChild(ok);
                }).catch(function (e) { apply.disabled = false; alertBox.textContent = String(e); });
            });
            var cancel = el("button", "al-btn secondary", "Cancel");
            cancel.addEventListener("click", closeModal);
            rowb.appendChild(apply); rowb.appendChild(cancel);
            box.appendChild(rowb);

            // sources close over working/prefs; each re-renders the reg table
            function sourceTemplate() {
                var p = el("div", "al-card"); p.appendChild(el("h3", null, "Add settings from a template GPO"));
                var host = el("div"); host.appendChild(el("div", "al-loading", "loading GPOs…"));
                p.appendChild(host);
                run("gpo-template-list").then(function (r) {
                    clear(host);
                    var pk = pickerTable({
                        columns: [{ key: "display_name", label: "display name" }, { key: "gpo", label: "GUID" }],
                        rows: r.gpos || [], mode: "multi", rowKey: function (g) { return g.gpo; }, height: 180
                    });
                    host.appendChild(pk.node);
                    var add = el("button", "al-btn secondary", "Add selected GPOs' settings");
                    var msg = el("span", "hint", "");
                    add.addEventListener("click", function () {
                        var sel = pk.selected(); if (!sel.length) { msg.textContent = " pick at least one GPO"; return; }
                        add.disabled = true; msg.textContent = " reading…";
                        var chain = Promise.resolve(); var added = 0;
                        sel.forEach(function (g) {
                            chain = chain.then(function () {
                                return run("gpo-registry-list", { gpo: g.gpo }).then(function (rr) {
                                    (rr.settings || []).forEach(function (s) {
                                        working.push({ id: nid(), keyname: s.keyname, valuename: s.valuename, class: s.class, type: s.type, data: s.data, origin: "added" });
                                        added++;
                                    });
                                });
                            });
                        });
                        chain.then(function () { add.disabled = false; msg.textContent = " added " + added; drawReg(); })
                             .catch(function (e) { add.disabled = false; msg.textContent = " " + e; });
                    });
                    host.appendChild(add); host.appendChild(msg);
                }).catch(function (e) { clear(host); host.appendChild(el("div", "al-alert err", String(e))); });
                return p;
            }
            function sourceAdmx() {
                var p = el("div", "al-card"); p.appendChild(el("h3", null, "Add from an ADMX policy"));
                var loadBtn = el("button", "al-btn secondary", "Load ADMX to central store");
                var host = el("div"); var msg = el("span", "hint", "");
                var statePick = pickerTable({
                    columns: [{ key: "state", label: "state" }],
                    rows: [{ state: "Enabled" }, { state: "Disabled" }], mode: "single",
                    rowKey: function (r) { return r.state; }, selectedKeys: ["Enabled"], height: 90
                });
                var showUnresolved = false;
                function loadList() {
                    clear(host); host.appendChild(el("div", "al-loading", "listing…"));
                    run("gpo-admx-list").then(function (r) {
                        clear(host);
                        var pols = r.policies || [];
                        if (!pols.length) { host.appendChild(el("div", "hint", "no ADMX loaded — click Load above")); return; }
                        // Policies whose display name never resolved from the ADML
                        // (raw string.POL_* references) are noise — hide by default.
                        var unresolvedCount = pols.filter(function (p) { return p.unresolved; }).length;
                        var toggleRow = el("label", "al-inline-check");
                        var cb = el("input"); cb.type = "checkbox"; cb.checked = showUnresolved;
                        toggleRow.appendChild(cb);
                        toggleRow.appendChild(document.createTextNode(
                            " show unresolved policy names (" + unresolvedCount + " hidden)"));
                        cb.addEventListener("change", function () { showUnresolved = cb.checked; loadList(); });
                        host.appendChild(toggleRow);
                        var rows = pols.filter(function (p) { return showUnresolved || !p.unresolved; });
                        var pk = pickerTable({
                            columns: [{ key: "_name", label: "policy" }, { key: "class", label: "class" },
                                      { key: "_reg", label: "key\\value" }],
                            rows: rows.map(function (pol) {
                                return { _pol: pol, _name: pol.display || pol.id, class: pol.class, _reg: pol.key + "\\" + (pol.valuename || pol.id) };
                            }),
                            mode: "multi", rowKey: function (r, i) { return r._pol.id + ":" + i; }, height: 220
                        });
                        host.appendChild(pk.node);
                        host.appendChild(el("label", null, "state")); host.appendChild(statePick.node);
                        var add = el("button", "al-btn secondary", "Add selected policies");
                        add.addEventListener("click", function () {
                            var enabling = (statePick.selected()[0] || { state: "Enabled" }).state === "Enabled";
                            var sel = pk.selected(); if (!sel.length) { msg.textContent = " pick a policy"; return; }
                            sel.forEach(function (r) {
                                var pol = r._pol;
                                var typ = enabling ? pol.enabled_type : pol.disabled_type;
                                var data = enabling ? pol.enabled_data : pol.disabled_data;
                                if (typ == null) { typ = "REG_DWORD"; data = enabling ? 1 : 0; }
                                var cls = (pol.class || "BOTH").toUpperCase();
                                if (cls !== "MACHINE" && cls !== "USER") cls = "BOTH";
                                working.push({ id: nid(), keyname: pol.key, valuename: pol.valuename || pol.id, class: cls, type: typ, data: data, origin: "added" });
                            });
                            msg.textContent = " added " + sel.length; drawReg();
                        });
                        host.appendChild(add);
                    }).catch(function (e) { clear(host); host.appendChild(el("div", "al-alert err", String(e))); });
                }
                loadBtn.addEventListener("click", function () {
                    loadBtn.disabled = true; msg.textContent = " loading…";
                    run("gpo-admxload").then(function () { loadBtn.disabled = false; msg.textContent = " loaded"; loadList(); })
                        .catch(function (e) { loadBtn.disabled = false; msg.textContent = " " + e; });
                });
                p.appendChild(loadBtn); p.appendChild(msg); p.appendChild(host);
                loadList();
                return p;
            }
            function sourceRaw() {
                var p = el("div", "al-card"); p.appendChild(el("h3", null, "Add a raw registry setting"));
                var key = el("input"); key.placeholder = "Software\\Policies\\...";
                var val = el("input"); val.placeholder = "valueName";
                var clsPick = pickerTable({
                    columns: [{ key: "class", label: "class" }],
                    rows: [{ class: "MACHINE" }, { class: "USER" }, { class: "BOTH" }], mode: "single",
                    rowKey: function (r) { return r.class; }, selectedKeys: ["MACHINE"], height: 110
                });
                var ve = valueEditor("REG_SZ", "");
                p.appendChild(el("label", null, "key")); p.appendChild(key);
                p.appendChild(el("label", null, "value")); p.appendChild(val);
                p.appendChild(el("label", null, "class")); p.appendChild(clsPick.node);
                p.appendChild(ve.node);
                var add = el("button", "al-btn secondary", "Add setting");
                var msg = el("span", "hint", "");
                add.addEventListener("click", function () {
                    if (!key.value || !val.value) { msg.textContent = " key and value required"; return; }
                    var v = ve.getValue();
                    var cls = (clsPick.selected()[0] || { class: "MACHINE" }).class;
                    working.push({ id: nid(), keyname: key.value, valuename: val.value, class: cls, type: v.type, data: v.data, origin: "added" });
                    key.value = val.value = ""; msg.textContent = " added"; drawReg();
                });
                p.appendChild(add); p.appendChild(msg);
                return p;
            }
            function sourcePref() {
                var p = el("div", "al-card"); p.appendChild(el("h3", null, "Add a preference (samba CSE)"));
                var csePick = pickerTable({
                    columns: [{ key: "cse", label: "CSE" }],
                    rows: GPO_CSES.map(function (c) { return { cse: c }; }), mode: "single",
                    rowKey: function (r) { return r.cse; }, selectedKeys: ["smb_conf"], height: 200
                });
                var entry = el("input"); entry.placeholder = "entry / setting (blank for motd/issue)";
                var value = el("input"); value.placeholder = "value (empty unsets)";
                p.appendChild(el("label", null, "CSE")); p.appendChild(csePick.node);
                p.appendChild(el("label", null, "entry")); p.appendChild(entry);
                p.appendChild(el("label", null, "value")); p.appendChild(value);
                var add = el("button", "al-btn secondary", "Stage preference");
                add.addEventListener("click", function () {
                    var cse = (csePick.selected()[0] || { cse: "smb_conf" }).cse;
                    prefs.push({ cse: cse, entry: entry.value, value: value.value });
                    entry.value = value.value = ""; drawPrefs();
                });
                p.appendChild(add);
                return p;
            }

            // auto-load the target GPO's current registry settings
            run("gpo-registry-list", { gpo: target }).then(function (r) {
                (r.settings || []).forEach(function (s) {
                    working.push({ id: nid(), keyname: s.keyname, valuename: s.valuename, class: s.class, type: s.type, data: s.data, origin: "current", dirty: false });
                });
                drawReg();
            }).catch(function (e) { clear(regHost); regHost.appendChild(el("div", "al-alert err", "auto-load failed: " + e)); });
            drawPrefs();
        });
    }

    /* Apply the composed changes: adds/edits merge via gpo load, removed
     * current entries are removed, staged preferences set via gpo manage. */
    function applyCompose(target, applyList, removeList, prefs) {
        var results = { applied: null, removed: null, preferences: [] };
        var chain = Promise.resolve();
        if (applyList.length) chain = chain.then(function () {
            return run("gpo-settings-apply", { gpo: target, entries: JSON.stringify(applyList) })
                .then(function (r) { results.applied = r; });
        });
        if (removeList.length) chain = chain.then(function () {
            return run("gpo-settings-remove", { gpo: target, entries: JSON.stringify(removeList) })
                .then(function (r) { results.removed = r; });
        });
        prefs.forEach(function (pr) {
            chain = chain.then(function () {
                return run("gpo-pref-set", { gpo: target, cse: pr.cse, entry: pr.entry, value: pr.value })
                    .then(function (r) { results.preferences.push(r); });
            });
        });
        return chain.then(function () { return results; });
    }

    /* Build a registry tree {class -> node} from flat entries. A node is
     * {label, fullKey, cls, children:{seg:node}, values:[entry]}; a value
     * attaches to the node for its full key (which may also have children). */
    /* GPO edit modal — two panes. LEFT: a filter bar (setting / os /
     * subsystem) above a facet TREE of ALL AVAILABLE settings grouped by
     * OS type -> subsystem, auto-populated from the catalog. Selecting a
     * subsystem group lists its settings on the RIGHT; editing a setting
     * composes it into the GPO. "Advanced compose" stacks the compose modal. */
    function gpoEditModal(target) {
        if (!target) { return; }
        var catalog = [], current = [], facets = { os_types: [], subsystems: [] };
        var fSetting = "", fOs = "", fSubs = {};
        var expanded = {}, selGroup = null;

        modal("Edit Group Policy", function (box) {
            // Identify the GPO by its DISPLAY NAME, not just the GUID. A GUID alone
            // cannot be checked against intent — {31B2F340-...} and {6AC1786C-...}
            // are the two default policies and differ by one character in a glance.
            // The name is resolved asynchronously; the GUID renders immediately so
            // the header never sits empty, and stays visible because it is what the
            // URL, the backend verbs and SYSVOL all key on.
            var head = el("div", "al-edit-head");
            var nameEl = el("div", "al-edit-gpo-name", "\u2026");
            var guidLine = el("div", "hint", "GPO: ");
            guidLine.appendChild(el("kbd", "al", target));
            head.appendChild(nameEl); head.appendChild(guidLine);
            box.appendChild(head);
            run("gpo-show", { gpo: target }).then(function (r) {
                var n = r && r.meta && r.meta.display_name;
                nameEl.textContent = n || "(unnamed GPO)";
                if (!n) nameEl.classList.add("muted");
            }, function () {
                // A failed lookup must not imply the GPO is nameless.
                nameEl.textContent = "(name unavailable)";
                nameEl.classList.add("muted");
            });
            var panes = el("div", "al-edit-panes");
            var treePane = el("div", "al-edit-tree"); treePane.style.width = "500px";
            var splitter = el("div", "al-edit-splitter");
            var listPane = el("div", "al-edit-list");
            panes.appendChild(treePane); panes.appendChild(splitter); panes.appendChild(listPane);
            box.appendChild(panes);

            splitter.addEventListener("mousedown", function (ev) {
                ev.preventDefault();
                var startX = ev.clientX, startW = treePane.offsetWidth;
                function move(e) { treePane.style.width = Math.max(240, Math.min(900, startW + (e.clientX - startX))) + "px"; }
                function up() { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); }
                document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
            });

            // ---- filter bar (setting / os / subsystem) --------------------
            var filterBar = el("div", "al-tree-filters");
            var setInput = el("input", "al-tree-filter-setting"); setInput.type = "search"; setInput.placeholder = "filter setting…";
            setInput.addEventListener("input", function () { fSetting = setInput.value; drawTree(); });
            filterBar.appendChild(setInput);
            var osRow = el("div", "al-facet-row");
            var subRow = el("div", "al-facet-row");
            filterBar.appendChild(osRow); filterBar.appendChild(subRow);
            treePane.appendChild(filterBar);
            var treeHost = el("div"); treePane.appendChild(treeHost);

            function osBtn(label, val) {
                var b = el("button", "al-chip" + (fOs === val ? " on" : ""), label); b.type = "button";
                b.addEventListener("click", function () { fOs = val; drawFilters(); drawTree(); });
                return b;
            }
            function subChip(s) {
                var b = el("button", "al-chip" + (fSubs[s] ? " on" : ""), s); b.type = "button";
                b.addEventListener("click", function () { if (fSubs[s]) delete fSubs[s]; else fSubs[s] = true; drawFilters(); drawTree(); });
                return b;
            }
            function drawFilters() {
                clear(osRow); osRow.appendChild(el("span", "al-facet-lbl", "os"));
                osRow.appendChild(osBtn("All", ""));
                facets.os_types.forEach(function (o) { osRow.appendChild(osBtn(o, o)); });
                clear(subRow); subRow.appendChild(el("span", "al-facet-lbl", "subsystem"));
                facets.subsystems.forEach(function (s) { subRow.appendChild(subChip(s)); });
            }

            function passes(e) {
                if (fOs && e.os_type !== fOs) return false;
                if (Object.keys(fSubs).length && !e.subsystems.some(function (s) { return fSubs[s]; })) return false;
                if (fSetting) {
                    var hay = (e.name + " " + (e.keyname || "") + " " + (e.valuename || "") + " " + (e.cse || "")).toLowerCase();
                    if (hay.indexOf(fSetting.toLowerCase()) < 0) return false;
                }
                return true;
            }
            function groups() {
                var g = {};
                catalog.filter(passes).forEach(function (e) {
                    g[e.os_type] = g[e.os_type] || {};
                    var subs = e.subsystems.length ? e.subsystems : ["other"];
                    subs.forEach(function (s) {
                        if (Object.keys(fSubs).length && !fSubs[s]) return;
                        (g[e.os_type][s] = g[e.os_type][s] || []).push(e);
                    });
                });
                return g;
            }
            function drawTree() {
                clear(treeHost);
                var g = groups(), osList = Object.keys(g).sort();
                if (!osList.length) { treeHost.appendChild(el("div", "hint", "no settings match the filters")); return; }
                osList.forEach(function (os) {
                    var total = 0; Object.keys(g[os]).forEach(function (s) { total += g[os][s].length; });
                    var open = expanded["os:" + os] !== false;
                    var osRowEl = el("div", "al-tree-row");
                    osRowEl.appendChild(el("span", "al-tree-tog", open ? "▾" : "▸"));
                    osRowEl.appendChild(el("span", "al-tree-label", os));
                    osRowEl.appendChild(badge(String(total), "dim"));
                    osRowEl.addEventListener("click", function () { expanded["os:" + os] = !open; drawTree(); });
                    treeHost.appendChild(osRowEl);
                    if (!open) return;
                    Object.keys(g[os]).sort().forEach(function (sub) {
                        var isSel = selGroup && selGroup.os === os && selGroup.sub === sub;
                        var row = el("div", "al-tree-row sub" + (isSel ? " sel" : ""));
                        row.appendChild(el("span", "al-tree-tog", ""));
                        row.appendChild(el("span", "al-tree-label", sub));
                        row.appendChild(badge(String(g[os][sub].length), "ok"));
                        row.addEventListener("click", function () { selGroup = { os: os, sub: sub }; drawTree(); drawList(); });
                        treeHost.appendChild(row);
                    });
                });
            }

            // ---- right pane -----------------------------------------------
            function curFor(e) {
                if (e.source !== "admx") return null;
                for (var i = 0; i < current.length; i++) {
                    var c = current[i];
                    if (c.class === e.class && c.keyname === e.keyname && c.valuename === e.valuename) return c;
                }
                return null;
            }
            function drawList() {
                clear(listPane);
                if (!selGroup) { listPane.appendChild(el("div", "hint", "select a subsystem group in the tree to list its settings")); return; }
                listPane.appendChild(el("div", "al-edit-keyhdr")).appendChild(el("kbd", "al", selGroup.os + " · " + selGroup.sub));
                var g = groups();
                var entries = (g[selGroup.os] && g[selGroup.os][selGroup.sub]) || [];
                listPane.appendChild(tableOf(["setting", "key / cse", "in GPO", ""], entries.map(function (e) {
                    var cur = curFor(e);
                    var acts = el("div", "al-actions");
                    var edit = el("button", "al-btn", cur ? "edit" : "compose");
                    edit.addEventListener("click", function () { editSetting(e); });
                    acts.appendChild(edit);
                    var keycell = el("div", "al-wrapcell");
                    keycell.textContent = e.source === "cse" ? ("CSE: " + e.cse) : (e.class + " " + e.keyname + "\\" + e.valuename);
                    return [e.name, keycell, cur ? badge(dataPreview(cur.type, cur.data), "ok") : badge("no", "dim"), acts];
                })));
            }

            function tagEditor(e) {
                var wrap = el("div", "al-card");
                wrap.appendChild(el("h3", null, "OS type & subsystems"));
                var osPick = el("div", "al-facet-row"); osPick.appendChild(el("span", "al-facet-lbl", "os"));
                var chosenOs = e.os_type;
                facets.os_types.forEach(function (o) {
                    var b = el("button", "al-chip" + (chosenOs === o ? " on" : ""), o); b.type = "button";
                    b.addEventListener("click", function () {
                        chosenOs = o;
                        [].forEach.call(osPick.querySelectorAll(".al-chip"), function (c) { c.className = "al-chip" + (c.textContent === o ? " on" : ""); });
                    });
                    osPick.appendChild(b);
                });
                wrap.appendChild(osPick);
                var subPick = el("div", "al-facet-row"); subPick.appendChild(el("span", "al-facet-lbl", "subsystems"));
                var chosen = {}; e.subsystems.forEach(function (s) { chosen[s] = true; });
                facets.subsystems.forEach(function (s) {
                    var b = el("button", "al-chip" + (chosen[s] ? " on" : ""), s); b.type = "button";
                    b.addEventListener("click", function () { if (chosen[s]) delete chosen[s]; else chosen[s] = true; b.className = "al-chip" + (chosen[s] ? " on" : ""); });
                    subPick.appendChild(b);
                });
                wrap.appendChild(subPick);
                var save = el("button", "al-btn secondary", "Save tags");
                var msg = el("span", "hint", "");
                save.addEventListener("click", function () {
                    var subs = Object.keys(chosen);
                    run("gpo-catalog-tag", { id: e.id, os_type: chosenOs, subsystems: subs.join(",") }).then(function () {
                        e.os_type = chosenOs; e.subsystems = subs; msg.textContent = " saved"; drawTree();
                    }).catch(function (err) { msg.textContent = " " + err; });
                });
                wrap.appendChild(save); wrap.appendChild(msg);
                return wrap;
            }

            function editSetting(e) {
                clear(listPane);
                listPane.appendChild(el("div", "al-edit-keyhdr")).appendChild(el("kbd", "al", e.name));
                listPane.appendChild(tagEditor(e));
                var body = el("div", "al-card");
                if (e.source === "cse") {
                    body.appendChild(el("h3", null, "Preference (" + e.cse + ")"));
                    var entry = el("input"); entry.placeholder = "entry / setting (blank for motd/issue)";
                    var value = el("input"); value.placeholder = "value (empty unsets)";
                    body.appendChild(el("label", null, "entry")); body.appendChild(entry);
                    body.appendChild(el("label", null, "value")); body.appendChild(value);
                    var papply = el("button", "al-btn", "Compose into GPO");
                    var pmsg = el("span", "hint", "");
                    papply.addEventListener("click", function () {
                        papply.disabled = true; pmsg.textContent = " applying…";
                        run("gpo-pref-set", { gpo: target, cse: e.cse, entry: entry.value, value: value.value })
                            .then(function () { papply.disabled = false; pmsg.textContent = " composed"; })
                            .catch(function (err) { papply.disabled = false; pmsg.textContent = " " + err; });
                    });
                    body.appendChild(papply); body.appendChild(pmsg);
                } else {
                    body.appendChild(el("h3", null, "Registry value"));
                    body.appendChild(el("div", "hint", e.class + "  " + e.keyname + "\\" + e.valuename));
                    var cur = curFor(e);
                    var initType = cur ? cur.type : (e.enabled_type || "REG_DWORD");
                    var initData = cur ? cur.data : (e.enabled_data !== undefined && e.enabled_data !== null ? e.enabled_data : 1);
                    var ve = valueEditor(initType, initData);
                    body.appendChild(ve.node);
                    var apply = el("button", "al-btn", cur ? "Update in GPO" : "Compose into GPO");
                    var msg = el("span", "hint", "");
                    apply.addEventListener("click", function () {
                        var v = ve.getValue();
                        var ent = [{ keyname: e.keyname, valuename: e.valuename, class: e.class, type: v.type, data: v.data }];
                        apply.disabled = true; msg.textContent = " applying…";
                        run("gpo-settings-apply", { gpo: target, entries: JSON.stringify(ent) }).then(function () {
                            return run("gpo-registry-list", { gpo: target });
                        }).then(function (r) { current = r.settings || []; apply.disabled = false; msg.textContent = " composed"; })
                          .catch(function (err) { apply.disabled = false; msg.textContent = " " + err; });
                    });
                    body.appendChild(apply);
                    if (cur) {
                        var rm = el("button", "al-btn danger", "Remove from GPO");
                        rm.addEventListener("click", function () {
                            rm.disabled = true;
                            run("gpo-settings-remove", { gpo: target, entries: JSON.stringify([{ keyname: e.keyname, valuename: e.valuename, class: e.class }]) })
                                .then(function () { return run("gpo-registry-list", { gpo: target }); })
                                .then(function (r) { current = r.settings || []; msg.textContent = " removed"; })
                                .catch(function (err) { rm.disabled = false; msg.textContent = " " + err; });
                        });
                        body.appendChild(rm);
                    }
                    body.appendChild(msg);
                }
                var back = el("button", "al-btn secondary", "Back to list");
                back.addEventListener("click", drawList);
                body.appendChild(back);
                listPane.appendChild(body);
            }

            var actions = el("div", "row");
            var adv = el("button", "al-btn secondary", "Advanced compose ▸");
            adv.addEventListener("click", function () { openModal("gpo-compose", { target: target }); });
            var close = el("button", "al-btn secondary", "Close");
            close.addEventListener("click", closeModal);
            actions.appendChild(adv); actions.appendChild(close);
            box.appendChild(actions);

            treeHost.appendChild(el("div", "al-loading", "loading available settings…"));
            Promise.all([run("gpo-catalog"), run("gpo-registry-list", { gpo: target })]).then(function (res) {
                catalog = res[0].entries || [];
                facets = { os_types: res[0].os_types || [], subsystems: res[0].subsystems || [] };
                current = res[1].settings || [];
                drawFilters(); drawTree(); drawList();
            }).catch(function (err) { clear(treeHost); treeHost.appendChild(el("div", "al-alert err", String(err))); });
        }, true);
    }

    function gpoAdmxModal() {
        modal("ADMX central store", function (box) {
            var loadBtn = el("button", "al-btn", "Load samba ADMX into SYSVOL");
            var out = el("div"); out.appendChild(el("div", "al-loading", "listing central store…"));
            function refresh() {
                run("gpo-admx-list").then(function (r) {
                    clear(out);
                    out.appendChild(el("div", "hint", "ADMX files: " + (r.admx_files || []).join(", ") || "(none loaded)"));
                    out.appendChild(el("div", "hint", "Policies available: " + (r.policy_count || 0)));
                    out.appendChild(tableOf(["policy", "class", "key"],
                        (r.policies || []).slice(0, 300).map(function (p) {
                            return [p.display || p.id, p.class, p.key + "\\" + p.valuename];
                        })));
                }).catch(function (e) { clear(out); out.appendChild(el("div", "al-alert err", String(e))); });
            }
            loadBtn.addEventListener("click", function () {
                loadBtn.disabled = true;
                run("gpo-admxload").then(function () { loadBtn.disabled = false; refresh(); })
                    .catch(function (e) { loadBtn.disabled = false; clear(out); out.appendChild(el("div", "al-alert err", String(e))); });
            });
            box.appendChild(loadBtn);
            box.appendChild(out);
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
        modal("GPO preferences (CSEs)", function (box) {
            box.appendChild(el("div", "hint", "GPO: ")).appendChild(el("kbd", "al", gpo));
            var cse = el("select");
            ["smb_conf", "security", "motd", "issue", "sudoers", "files", "symlink", "openssh", "scripts", "access"]
                .forEach(function (x) { var o = el("option", null, x); o.value = x; cse.appendChild(o); });
            var listOut = el("div");
            function listCse() {
                clear(listOut); listOut.appendChild(el("div", "al-loading", "listing…"));
                run("gpo-pref-list", { gpo: gpo, cse: cse.value }).then(function (r) {
                    clear(listOut);
                    listOut.appendChild(tableOf([cse.value + " items"],
                        (r.items || []).map(function (i) { return [i]; })));
                    if (!(r.items || []).length) listOut.appendChild(el("div", "hint", "(none set)"));
                }).catch(function (e) { clear(listOut); listOut.appendChild(el("div", "al-alert err", String(e))); });
            }
            cse.addEventListener("change", listCse);
            box.appendChild(el("label", null, "CSE")); box.appendChild(cse);
            var entry = el("input"); entry.placeholder = "entry (per CSE)";
            var value = el("input"); value.placeholder = "value (empty unsets)";
            box.appendChild(el("label", null, "entry")); box.appendChild(entry);
            box.appendChild(el("label", null, "value")); box.appendChild(value);
            var setBtn = el("button", "al-btn", "Set preference");
            var msg = el("span", "hint", "");
            setBtn.addEventListener("click", function () {
                setBtn.disabled = true; msg.textContent = " setting…";
                run("gpo-pref-set", { gpo: gpo, cse: cse.value, entry: entry.value, value: value.value })
                    .then(function () { setBtn.disabled = false; msg.textContent = " set"; listCse(); })
                    .catch(function (e) { setBtn.disabled = false; msg.textContent = " " + e; });
            });
            box.appendChild(setBtn); box.appendChild(msg);
            box.appendChild(listOut);
            var close = el("button", "al-btn secondary", "Close");
            close.addEventListener("click", closeModal); box.appendChild(close);
            listCse();
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
                var compose = el("button", "al-btn", "compose more settings");
                compose.addEventListener("click", function () { openModal("gpo-compose", { target: gpo }); });
                out.appendChild(compose);
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

    // ----------------------------------------------------------------- dcs
    function renderDcs() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Promote new DC", "dc-promote", {}, ""));
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
                 ["demote", "dc-demote"]].forEach(function (p) {
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

    // ---------------------------------------------------------------- boot
    var RENDER = { overview: renderOverview,
                   objects: renderObjects, gpo: renderGpo,
                   sites: renderSites, dns: renderDns, dcs: renderDcs,
                   clients: renderClients, activity: renderActivity };

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
