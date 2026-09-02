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
    var shownModalKey = null;      // JSON of the options that opened the modal

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
    /* Open a modal = navigate to the current tab with modal options. */
    function openModal(key, extra) {
        var opts = { modal: key };
        Object.keys(extra || {}).forEach(function (k) { opts[k] = extra[k]; });
        nav([currentTab], opts);
    }
    /* Close a modal = navigate back to the bare tab (clears options). */
    function closeModal() { nav([currentTab]); }

    function closeModalDom() {
        clear(document.getElementById("al-modal-host"));
    }

    /* The router. Renders the tab body only when the tab actually changes
     * (so opening/closing a modal never tears down the tab), then opens or
     * closes the modal to match the options. */
    function route() {
        var loc = cockpit.location;
        var tab = (loc.path && loc.path[0]) || "overview";
        if (!RENDER[tab]) tab = "overview";
        currentTab = tab;
        if (tab !== lastRenderedTab) {
            lastRenderedTab = tab;
            renderTabs();
            RENDER[tab]();
        }
        var opts = loc.options || {};
        var key = opts.modal ? JSON.stringify(opts) : null;
        if (key === shownModalKey) return;
        shownModalKey = key;
        if (!key) { closeModalDom(); return; }
        dispatchModal(opts.modal, opts);
    }

    function refreshTab() {
        lastRenderedTab = null;   // force a body re-render on next route
        route();
    }

    /* Map an options object to the right modal builder. Generic verbs render
     * from the schema; the gpo-* views are hand-built. */
    function dispatchModal(key, opts) {
        var presets = {};
        Object.keys(opts).forEach(function (k) {
            if (k !== "modal") presets[k] = opts[k];
        });
        if (SCHEMA && SCHEMA.verbs && SCHEMA.verbs[key]) {
            verbForm(key, presets);
            return;
        }
        switch (key) {
            case "gpo-compose":   gpoComposeModal(opts.target); break;
            case "gpo-admx":      gpoAdmxModal(); break;
            case "gpo-templates": gpoTemplatesModal(); break;
            case "gpo-prefs":     gpoPrefsModal(opts.gpo); break;
            case "gpo-detail":    gpoDetailModal(opts.gpo); break;
            default: closeModalDom();
        }
    }

    // ------------------------------------------------------------- modal DOM
    /* Build a modal shell into #al-modal-host and hand `box` to the builder.
     * Backdrop click and Escape both navigate the modal closed (URL-aware). */
    function modal(title, bodyBuilder) {
        var host = document.getElementById("al-modal-host");
        clear(host);
        var back = el("div", "al-backdrop");
        var box = el("div", "al-modal");
        box.appendChild(el("h2", null, title));
        back.addEventListener("click", function (ev) {
            if (ev.target === back) closeModal();
        });
        back.appendChild(box);
        host.appendChild(back);
        bodyBuilder(box);
        return box;
    }

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
        if (!spec) { closeModalDom(); return; }
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
                    modal(verb, function (box) { fillResult(box, verb, res); });
                }).catch(function (e) {
                    b.disabled = false;
                    modal(verb + " failed", function (box) {
                        box.appendChild(el("div", "al-alert err", String(e)));
                        var ok = el("button", "al-btn", "Close");
                        ok.addEventListener("click", closeModalDom);
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

    // ---------------------------------------------------------------- tabs
    var TABS = [
        ["overview", "Overview"], ["users", "Users & Groups"],
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
        var grid = el("div", "al-grid");
        m.appendChild(grid);
        run("domain-info").then(function (r) {
            var c = card("Domain");
            var info = r.info || {};
            var rows = ["forest", "domain", "netbios_domain", "dc_name", "server_site"]
                .filter(function (k) { return info[k]; })
                .map(function (k) { return [k.replace(/_/g, " "), info[k]]; });
            if (info.levels && info.levels.forest_function_level)
                rows.push(["forest level", info.levels.forest_function_level]);
            c.appendChild(tableOf(["", ""], rows));
            grid.insertBefore(c, grid.firstChild);
        }).catch(function (e) { grid.appendChild(failCard("Domain", e)); });
        run("fsmo-show").then(function (r) {
            var c = card("FSMO roles");
            c.appendChild(tableOf(["role", "holder"], Object.keys(r.roles).sort().map(function (k) {
                return [k.replace("MasterRole", ""), badge(r.roles[k], "ok")];
            })));
            grid.appendChild(c);
        }).catch(function (e) { grid.appendChild(failCard("FSMO roles", e)); });
        run("health").then(function (r) {
            var c = card("Replication health", true);
            c.appendChild(tableOf(["DC", "state", "links", "failing links"], r.dcs.map(function (d) {
                return [d.dc, badge(d.state, d.state === "running" ? "ok" : "err"), d.links,
                        d.replication_ok === null ? badge("n/a") :
                            badge(String(d.failures), d.failures === 0 ? "ok" : "err")];
            })));
            grid.appendChild(c);
        }).catch(function (e) { grid.appendChild(failCard("Replication health", e)); });
        run("sysvol-status").then(function (r) {
            var c = card("SYSVOL");
            c.appendChild(r.identical
                ? el("div", "al-alert ok", "SYSVOL is byte-identical on every DC.")
                : el("div", "al-alert err", "SYSVOL DIFFERS between DCs — run a sync."));
            c.appendChild(tableOf(["DC", "files", "content hash"],
                r.dcs.map(function (d) { return [d.dc, d.files, d.hash || d.error]; })));
            grid.appendChild(c);
        }).catch(function (e) { grid.appendChild(failCard("SYSVOL", e)); });
        run("status").then(function (r) {
            var c = card("Containers", true);
            c.appendChild(tableOf(["name", "kind", "ip", "state"], r.containers.map(function (x) {
                return [x.name, x.kind, x.ip, badge(x.state, x.state === "running" ? "ok" : "err")];
            })));
            grid.appendChild(c);
        }).catch(function (e) { grid.appendChild(failCard("Containers", e)); });
    }

    // ------------------------------------------------------ users & groups
    function renderUsers() {
        var m = content();
        var acts = el("div", "al-actions");
        acts.appendChild(actionButton("Create user", "user-create", {}, ""));
        acts.appendChild(actionButton("Create group", "group-create", {}));
        acts.appendChild(actionButton("Create OU", "ou-create", {}));
        m.appendChild(acts);
        var grid = el("div", "al-grid"); m.appendChild(grid);
        run("user-list").then(function (r) {
            var c = card("Users (" + r.count + ")", true);
            var filter = el("input"); filter.type = "search"; filter.placeholder = "filter…";
            filter.style.marginBottom = "0.5rem"; c.appendChild(filter);
            var holder = el("div"); c.appendChild(holder);
            function draw() {
                clear(holder);
                var f = filter.value.toLowerCase();
                var names = r.users.filter(function (u) { return !f || u.toLowerCase().indexOf(f) >= 0; }).slice(0, 200);
                holder.appendChild(tableOf(["user", "actions"], names.map(function (u) {
                    var box = el("div", "al-actions");
                    [["show", "user-show"], ["set password", "user-setpassword"],
                     ["disable", "user-disable"], ["enable", "user-enable"],
                     ["delete", "user-delete"]].forEach(function (p) {
                        box.appendChild(actionButton(p[0], p[1], { name: u }));
                    });
                    return [u, box];
                })));
            }
            filter.addEventListener("input", draw); draw();
            grid.appendChild(c);
        }).catch(function (e) { grid.appendChild(failCard("Users", e)); });
        run("group-list").then(function (r) {
            var c = card("Groups (" + r.groups.length + ")", true);
            c.appendChild(tableOf(["group", "actions"], r.groups.slice(0, 150).map(function (g) {
                var box = el("div", "al-actions");
                [["members", "group-show"], ["add member", "group-add-member"],
                 ["remove member", "group-remove-member"], ["delete", "group-delete"]].forEach(function (p) {
                    var preset = p[1] === "group-show" ? { name: g } : { group: g };
                    box.appendChild(actionButton(p[0], p[1], preset));
                });
                return [g, box];
            })));
            grid.appendChild(c);
        }).catch(function (e) { grid.appendChild(failCard("Groups", e)); });
        run("ou-list").then(function (r) {
            var c = card("Organizational units");
            c.appendChild(tableOf(["OU", ""], r.ous.map(function (o) {
                var box = el("div", "al-actions");
                box.appendChild(actionButton("delete", "ou-delete", { dn: o }));
                return [o, box];
            })));
            grid.appendChild(c);
        }).catch(function (e) { grid.appendChild(failCard("OUs", e)); });
        run("computer-list").then(function (r) {
            var c = card("Computers (" + r.computers.length + ")");
            c.appendChild(tableOf(["account"], r.computers.map(function (x) { return [x]; })));
            grid.appendChild(c);
        }).catch(function (e) { grid.appendChild(failCard("Computers", e)); });
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
        run("gpo-list").then(function (r) {
            var c = card("Group Policy objects (on " + r.pdc_emulator + ")", true);
            c.appendChild(tableOf(["GPO", "display name", "ver", "actions"], r.gpos.map(function (g) {
                var box = el("div", "al-actions");
                var compose = el("button", "al-btn", "compose");
                compose.addEventListener("click", function () {
                    openModal("gpo-compose", { target: g.gpo });
                });
                box.appendChild(compose);
                var detail = el("button", "al-btn secondary", "settings");
                detail.addEventListener("click", function () {
                    openModal("gpo-detail", { gpo: g.gpo });
                });
                box.appendChild(detail);
                var prefs = el("button", "al-btn secondary", "preferences");
                prefs.addEventListener("click", function () {
                    openModal("gpo-prefs", { gpo: g.gpo });
                });
                box.appendChild(prefs);
                box.appendChild(actionButton("backup", "gpo-backup", { gpo: g.gpo }));
                box.appendChild(actionButton("link", "gpo-link", { gpo: g.gpo }));
                box.appendChild(actionButton("unlink", "gpo-unlink", { gpo: g.gpo }));
                box.appendChild(actionButton("delete", "gpo-delete", { gpo: g.gpo }));
                return [el("kbd", "al", g.gpo), g.display_name, g.version, box];
            })));
            holder.appendChild(c);
        }).catch(function (e) { holder.appendChild(failCard("GPOs", e)); });
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
        if (!target) { closeModalDom(); return; }
        var working = [];          // {id, keyname, valuename, class, type, data, origin, dirty}
        var removed = [];          // current entries the user removed
        var prefs = [];            // staged preference ops
        var seq = 0;
        function nid() { return "e" + (seq++); }

        modal("Compose Group Policy", function (box) {
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
        if (!gpo) { closeModalDom(); return; }
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
        if (!gpo) { closeModalDom(); return; }
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
    var RENDER = { overview: renderOverview, users: renderUsers, gpo: renderGpo,
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
