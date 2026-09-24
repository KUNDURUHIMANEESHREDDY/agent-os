"""Generate a local CA + localhost server cert for agent-os TLS (dev only).

Writes ca.crt, server.crt, server.key into --out (default security/local-certs/).
Trust model: this CA signs ONLY localhost/127.0.0.1. Clients verify with
ca.crt (python: ssl.create_default_context(cafile=...); node:
NODE_EXTRA_CA_CERTS). Never import this CA anywhere else.

Requires: pip install cryptography
"""
from __future__ import annotations
import argparse
import datetime
import ipaddress
import os
from pathlib import Path

DEFAULT_OUT = Path(__file__).resolve().parent / "local-certs"


def main(out: Path) -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    out.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "agent-os-local-ca")])
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name).issuer_name(ca_name)
        .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(ca_key, hashes.SHA256())
    )

    srv_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    srv_cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
        .issuer_name(ca_name).public_key(srv_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now).not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName(
            [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )

    (out / "ca.crt").write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    (out / "server.crt").write_bytes(srv_cert.public_bytes(serialization.Encoding.PEM))
    key_path = out / "server.key"
    key_path.write_bytes(srv_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption()))
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass
    print(f"wrote {out / 'ca.crt'}, {out / 'server.crt'}, {out / 'server.key'}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    main(Path(ap.parse_args().out))
