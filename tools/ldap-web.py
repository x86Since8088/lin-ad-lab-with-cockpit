#!/usr/bin/env python3
"""
ldap-web.py — a self-contained read-only web browser for the samba-ad-lab directory.

WHY THIS EXISTS
---------------
Ubuntu 26.04 has essentially no working packaged GUI LDAP browser (see README.md).
This is ~350 lines of Python standard library. It has no build step, no node/npm,
no PHP, no Apache, and no dependencies beyond what is already on the host:

    python3 (stdlib only)  +  ldapsearch (ldap-utils)  +  a Kerberos ticket

It shells out to `ldapsearch -Y GSSAPI`, so it authenticates as whoever ran it,
using their existing ticket. It never asks for, stores, or handles a password.

It is READ ONLY. There is no write path in this file at all.

USAGE
-----
    kinit Administrator@AD.EDT1.LAB      # or: ./inspect.sh ticket
    ./ldap-web.py                        # then open http://127.0.0.1:8389/

It binds to 127.0.0.1 only and is not reachable from the network.
"""

import argparse
import base64
import html
import json
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DEFAULT_DC = "dc1.ad.edt1.lab"
DEFAULT_BASE = "DC=ad,DC=edt1,DC=lab"
DEFAULT_PORT = 8389

# Attributes worth decoding from their raw NDR blobs. python3-samba does the work.
BLOB_ATTRS = {"objectSid", "objectGUID", "nTSecurityDescriptor", "msDS-KeyVersionNumber"}

# A DN arrives from the browser and is handed to ldapsearch as an argv element
# (never a shell string). This still rejects anything with control characters or
# newlines so a crafted DN cannot smuggle extra LDIF or arguments.
DN_OK = re.compile(r"^[^\x00-\x1f]{0,2048}$")


class Directory:
    """Thin wrapper around `ldapsearch -Y GSSAPI`."""

    def __init__(self, host, base):
        self.host = host
        self.base = base

    def _run(self, base, scope, filt, attrs):
        if not DN_OK.match(base):
            raise ValueError("invalid base DN")
        cmd = [
            "ldapsearch", "-LLL", "-o", "ldif-wrap=no",
            "-Y", "GSSAPI", "-Q",                 # -Q silences the SASL banner
            "-H", f"ldap://{self.host}",
            "-b", base, "-s", scope, filt,
        ] + list(attrs)
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if p.returncode != 0 and not p.stdout.strip():
            raise RuntimeError(p.stderr.strip() or f"ldapsearch exited {p.returncode}")
        return parse_ldif(p.stdout)

    def children(self, dn):
        entries = self._run(dn, "one", "(objectClass=*)",
                            ["objectClass", "name"])
        out = []
        for e in entries:
            edn = e["dn"]
            classes = e.get("objectClass", [])
            out.append({
                "dn": edn,
                "rdn": edn.split(",", 1)[0],
                "kind": classify(classes),
                "classes": classes,
            })
        out.sort(key=lambda x: x["rdn"].lower())
        return out

    def entry(self, dn):
        # "*" is user attributes and "+" operational ones, but the security
        # descriptor is returned only when asked for by name.
        entries = self._run(dn, "base", "(objectClass=*)",
                            ["*", "+", "nTSecurityDescriptor"])
        if not entries:
            raise RuntimeError("no such entry")
        return entries[0]

    def search(self, filt, base=None, limit=200):
        entries = self._run(base or self.base, "sub", filt,
                            ["objectClass", "name", "sAMAccountName"])
        return [{"dn": e["dn"],
                 "rdn": e["dn"].split(",", 1)[0],
                 "kind": classify(e.get("objectClass", [])),
                 "sam": (e.get("sAMAccountName") or [""])[0]}
                for e in entries[:limit]]


def classify(classes):
    """Pick one icon-ish label from an objectClass list."""
    c = {x.lower() for x in classes}
    for name in ("computer", "user", "group", "organizationalunit",
                 "container", "domaindns", "builtindomain"):
        if name in c:
            return name
    return "other"


def parse_ldif(text):
    """
    Parse LDIF into [{attr: [values]}] with 'dn' as a plain string.

    ldapsearch is invoked with `-o ldif-wrap=no` so there are no folded
    continuation lines, but the unfolding is kept for safety.
    """
    text = text.replace("\n ", "")
    entries, cur = [], None
    for line in text.splitlines():
        if not line.strip():
            continue
        if line.startswith("#"):
            continue
        attr, _, val = line.partition(":")
        if val.startswith(":"):                       # base64 value
            raw = base64.b64decode(val[1:].strip())
            val = decode_blob(attr, raw)
        else:
            val = val.strip()
        if attr == "dn":
            cur = {"dn": val}
            entries.append(cur)
        elif cur is not None:
            cur.setdefault(attr, []).append(val)
    return entries


def decode_blob(attr, raw):
    """Turn a binary attribute into something a human can read, via python3-samba."""
    try:
        if attr == "objectSid":
            from samba.dcerpc import security
            from samba.ndr import ndr_unpack
            return str(ndr_unpack(security.dom_sid, raw))
        if attr == "objectGUID":
            from samba.dcerpc import misc
            from samba.ndr import ndr_unpack
            return str(ndr_unpack(misc.GUID, raw))
        if attr == "nTSecurityDescriptor":
            from samba.dcerpc import security
            from samba.ndr import ndr_unpack
            return ndr_unpack(security.descriptor, raw).as_sddl()
    except Exception:
        pass
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return "<binary %d bytes> %s" % (len(raw), raw[:24].hex())


PAGE = """<!doctype html>
<meta charset="utf-8"><title>%(base)s — directory browser</title>
<style>
 :root{--bg:#fff;--fg:#1a1a1a;--dim:#666;--line:#dcdcdc;--accent:#0b5cad;--panel:#f7f7f7}
 @media (prefers-color-scheme:dark){
   :root{--bg:#16181c;--fg:#e6e6e6;--dim:#9aa0a6;--line:#33363d;--accent:#6ab0ff;--panel:#1d2026}}
 *{box-sizing:border-box}
 body{margin:0;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
 header{padding:10px 14px;border-bottom:1px solid var(--line);background:var(--panel);
        display:flex;gap:12px;align-items:center;flex-wrap:wrap}
 header b{font-weight:600} header .dim{color:var(--dim)}
 input{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:5px;
       background:var(--bg);color:var(--fg);min-width:260px}
 main{display:grid;grid-template-columns:minmax(280px,38%%) 1fr;height:calc(100vh - 49px)}
 #tree,#detail{overflow:auto;padding:10px 14px}
 #tree{border-right:1px solid var(--line)}
 ul{list-style:none;margin:0;padding-left:16px}
 li>span.row{cursor:pointer;display:inline-block;padding:1px 3px;border-radius:4px}
 li>span.row:hover{background:var(--panel)}
 .sel{background:var(--accent)!important;color:#fff}
 .kind{color:var(--dim);font-size:11px;margin-left:6px}
 table{border-collapse:collapse;width:100%%}
 td{border-top:1px solid var(--line);padding:4px 8px;vertical-align:top;
    font-family:ui-monospace,monospace;font-size:12.5px;word-break:break-all}
 td.a{color:var(--accent);white-space:nowrap;width:1%%}
 h2{font-size:14px;font-family:ui-monospace,monospace;word-break:break-all;margin:0 0 10px}
 .err{color:#c0392b;white-space:pre-wrap}
</style>
<header>
  <b>%(base)s</b><span class="dim">via %(host)s · GSSAPI · read-only</span>
  <input id="q" placeholder="LDAP filter, e.g. (sAMAccountName=dc1$)">
</header>
<main><div id="tree"></div><div id="detail"><p class="dim">Select an entry.</p></div></main>
<script>
const BASE=%(basejson)s;
const j=async u=>{const r=await fetch(u);const d=await r.json();if(d.error)throw new Error(d.error);return d};
function node(item){
  const li=document.createElement('li');
  const row=document.createElement('span');row.className='row';
  row.innerHTML='<span class="tw">\\u25b8<\\/span> '+esc(item.rdn)+'<span class="kind">'+esc(item.kind)+'<\\/span>';
  li.appendChild(row);
  let kids=null;
  row.onclick=async e=>{
    e.stopPropagation();
    document.querySelectorAll('.sel').forEach(n=>n.classList.remove('sel'));
    row.classList.add('sel'); show(item.dn);
    if(kids){kids.hidden=!kids.hidden;row.querySelector('.tw').textContent=kids.hidden?'\\u25b8':'\\u25be';return}
    try{
      const c=await j('/api/children?dn='+encodeURIComponent(item.dn));
      kids=document.createElement('ul');c.forEach(x=>kids.appendChild(node(x)));
      li.appendChild(kids);row.querySelector('.tw').textContent='\\u25be';
    }catch(err){row.querySelector('.tw').textContent='\\u00b7'}
  };
  return li;
}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function show(dn){
  const d=document.getElementById('detail');
  d.innerHTML='<p class="dim">loading\\u2026</p>';
  try{
    const e=await j('/api/entry?dn='+encodeURIComponent(dn));
    let h='<h2>'+esc(e.dn)+'<\\/h2><table>';
    Object.keys(e).filter(k=>k!=='dn').sort().forEach(k=>{
      (e[k]||[]).forEach((v,i)=>{h+='<tr><td class="a">'+(i?'':esc(k))+'<\\/td><td>'+esc(v)+'<\\/td><\\/tr>'});
    });
    d.innerHTML=h+'<\\/table>';
  }catch(err){d.innerHTML='<p class="err">'+esc(err.message)+'<\\/p>'}
}
document.getElementById('q').onkeydown=async ev=>{
  if(ev.key!=='Enter')return;
  const d=document.getElementById('detail');d.innerHTML='<p class="dim">searching\\u2026</p>';
  try{
    const r=await j('/api/search?filter='+encodeURIComponent(ev.target.value));
    d.innerHTML='<h2>'+r.length+' result(s)<\\/h2><table>'+r.map(x=>
      '<tr><td class="a">'+esc(x.kind)+'<\\/td><td><a href="#" onclick="show('+
      JSON.stringify(x.dn).replace(/"/g,'&quot;')+');return false">'+esc(x.dn)+'<\\/a><\\/td><\\/tr>').join('')+'<\\/table>';
  }catch(err){d.innerHTML='<p class="err">'+esc(err.message)+'<\\/p>'}
};
(async()=>{
  const t=document.getElementById('tree');
  const ul=document.createElement('ul');
  ul.appendChild(node({dn:BASE,rdn:BASE,kind:'domainDNS'}));
  t.appendChild(ul);
})();
</script>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "ldap-web/1.0"
    directory = None            # set in main()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s %s\n" % (self.address_string(), fmt % args))

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/":
                body = (PAGE % {
                    "base": html.escape(self.directory.base),
                    "host": html.escape(self.directory.host),
                    "basejson": json.dumps(self.directory.base),
                }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif u.path == "/api/children":
                self._json(self.directory.children(q.get("dn", [self.directory.base])[0]))
            elif u.path == "/api/entry":
                self._json(self.directory.entry(q["dn"][0]))
            elif u.path == "/api/search":
                self._json(self.directory.search(q.get("filter", ["(objectClass=*)"])[0]))
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e)}, 500)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default=DEFAULT_DC, help="DC to query (default %(default)s)")
    ap.add_argument("--base", default=DEFAULT_BASE, help="base DN (default %(default)s)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--bind", default="127.0.0.1",
                    help="listen address; loopback only by default, and you should keep it that way")
    a = ap.parse_args()

    Handler.directory = Directory(a.host, a.base)
    # Fail fast and loudly if there is no usable ticket, rather than showing an
    # empty tree in the browser and leaving the user to guess why.
    try:
        Handler.directory._run(a.base, "base", "(objectClass=*)", ["dn"])
    except Exception as e:
        sys.exit("cannot query %s as the current user: %s\n"
                 "Get a ticket first:  kinit Administrator@AD.EDT1.LAB\n"
                 "                 or:  ./inspect.sh ticket" % (a.host, e))

    srv = ThreadingHTTPServer((a.bind, a.port), Handler)
    print("directory browser for %s\n  http://%s:%d/\nCtrl-C to stop."
          % (a.base, a.bind, a.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
