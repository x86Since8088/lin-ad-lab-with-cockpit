#!/usr/bin/env python3
"""Probe what security layer an RDP server will actually negotiate.

Sends a raw X.224 Connection Request (MS-RDPBCGR 2.2.1.1) carrying an
RDP_NEG_REQ that advertises a chosen set of protocols, and decodes the
RDP_NEG_RSP / RDP_NEG_FAILURE that comes back. This is the only unambiguous
way to answer "does this server do NLA?": a client's own log tells you what the
client settled for, not what the server was willing to do.

  PROTOCOL_RDP     0x00000000  legacy RC4 "standard RDP security"
  PROTOCOL_SSL     0x00000001  TLS 1.x
  PROTOCOL_HYBRID  0x00000002  CredSSP == NLA
  PROTOCOL_RDSTLS  0x00000004
  PROTOCOL_HYBRID_EX 0x00000008 CredSSP + early user authorization

usage: nla-probe.py HOST [PORT]
"""
import socket
import struct
import sys

PROTO = {
    0x00: "PROTOCOL_RDP (legacy RC4)",
    0x01: "PROTOCOL_SSL (TLS)",
    0x02: "PROTOCOL_HYBRID (CredSSP / NLA)",
    0x04: "PROTOCOL_RDSTLS",
    0x08: "PROTOCOL_HYBRID_EX (CredSSP + early user auth)",
}
FAILCODE = {
    1: "SSL_REQUIRED_BY_SERVER",
    2: "SSL_NOT_ALLOWED_BY_SERVER",
    3: "SSL_CERT_NOT_ON_SERVER",
    4: "INCONSISTENT_FLAGS",
    5: "HYBRID_REQUIRED_BY_SERVER",
    6: "SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER",
}


def decode_mask(mask):
    if mask == 0:
        return PROTO[0]
    bits = [name for bit, name in PROTO.items() if bit and (mask & bit)]
    left = mask & ~0x0F
    if left:
        bits.append("unknown bits 0x%08x" % left)
    return " | ".join(bits) if bits else "0x%08x" % mask


def build_cr(requested, cookie="mstshash=probe"):
    neg = struct.pack("<BBHI", 0x01, 0x00, 0x0008, requested)  # RDP_NEG_REQ
    routing = ("Cookie: " + cookie + "\r\n").encode()
    x224 = b"\xe0" + b"\x00\x00" + b"\x00\x00" + b"\x00" + routing + neg
    x224 = bytes([len(x224)]) + x224                            # LI octet
    return struct.pack(">BBH", 0x03, 0x00, 4 + len(x224)) + x224  # TPKT


def probe(host, port, requested, label):
    print("--- request: %s (0x%08x)" % (label, requested))
    try:
        s = socket.create_connection((host, port), timeout=8)
    except OSError as e:
        print("    CONNECT FAILED: %s" % e)
        return
    with s:
        s.sendall(build_cr(requested))
        try:
            hdr = s.recv(4)
        except socket.timeout:
            print("    no response (timeout)")
            return
        if len(hdr) < 4 or hdr[0] != 0x03:
            print("    not a TPKT response: %r" % hdr)
            return
        total = struct.unpack(">H", hdr[2:4])[0]
        body = b""
        while len(body) < total - 4:
            chunk = s.recv(total - 4 - len(body))
            if not chunk:
                break
            body += chunk
        print("    raw response: %s" % (hdr + body).hex())
        # body: LI, 0xD0 (CC), dst-ref(2), src-ref(2), class(1), [RDP_NEG_*]
        if len(body) < 7 or body[1] != 0xD0:
            print("    X.224 response is not a Connection Confirm (0x%02x)" % (body[1] if len(body) > 1 else 0))
            return
        rest = body[7:]
        if not rest:
            print("    RESULT: no RDP_NEG structure -> server is legacy-RDP only "
                  "(standard RC4 security, no TLS, no NLA)")
            return
        typ, flags, ln, val = struct.unpack("<BBHI", rest[:8])
        if typ == 0x02:
            print("    RDP_NEG_RSP  flags=0x%02x selectedProtocol=0x%08x" % (flags, val))
            print("    RESULT: server SELECTED %s" % decode_mask(val))
            fl = []
            if flags & 0x01: fl.append("EXTENDED_CLIENT_DATA_SUPPORTED")
            if flags & 0x02: fl.append("DYNVC_GFX_PROTOCOL_SUPPORTED")
            if flags & 0x08: fl.append("RESTRICTED_ADMIN_MODE_SUPPORTED")
            if flags & 0x10: fl.append("REDIRECTED_AUTHENTICATION_MODE_SUPPORTED")
            if fl:
                print("    negotiation flags: %s" % ", ".join(fl))
        elif typ == 0x03:
            print("    RDP_NEG_FAILURE failureCode=%d (%s)"
                  % (val, FAILCODE.get(val, "unknown")))
        else:
            print("    unexpected RDP_NEG type 0x%02x" % typ)


def main():
    host = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 3389
    print("=== X.224 security-layer probe of %s:%d ===" % (host, port))
    for requested, label in (
        (0x00000000, "RDP only"),
        (0x00000001, "TLS only"),
        (0x00000002, "CredSSP/NLA only"),
        (0x00000003, "TLS | CredSSP  (what mstsc/xfreerdp send by default)"),
        (0x0000000B, "TLS | CredSSP | CredSSP-EX"),
    ):
        probe(host, port, requested, label)
        print()


if __name__ == "__main__":
    main()
