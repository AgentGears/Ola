#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parent
MANIFEST=ROOT/'PACKAGE-MANIFEST.json'
DIGESTS=ROOT/'PACKAGE-DIGESTS.txt'
PACKAGE_ROOT=ROOT/'PACKAGE-ROOT.sha256'
CONSOLIDATED=ROOT/'ADR-0001-v1.4-Ola-Unified-Product-Architecture-Consolidated.md'
PARENT=ROOT/'ADR-0001-Ola-Unified-Product-Architecture.md'
ANNEXES=['ADR-0001-A-Programme-Status-and-Milestone-Semantics.md', 'ADR-0001-B-Transitional-Authority-and-Cutover-Protocol.md', 'ADR-0001-C-Runtime-Authority-and-Distributed-Failure-Semantics.md', 'ADR-0001-D-Contract-Envelope-and-Versioning-Requirements.md', 'ADR-0001-E-Memory-Subagent-Control-Cycle-Protocol.md', 'ADR-0001-F-Minimum-Trust-Privacy-and-Retention-Prerequisites.md', 'ADR-0001-R-Ratification-Manifest.md']
def sha256_bytes(data: bytes)->str: return hashlib.sha256(data).hexdigest()
def fail(message: str)->None:
    print(f"FAIL: {message}",file=sys.stderr); raise SystemExit(1)
manifest=json.loads(MANIFEST.read_text(encoding='utf-8'))
declared=set(manifest['files'])
actual={p.name for p in ROOT.iterdir() if p.is_file()}
if declared!=actual: fail(f"manifest file set mismatch: missing={sorted(declared-actual)}, extra={sorted(actual-declared)}")
digest_map={}
for line in DIGESTS.read_text(encoding='utf-8').splitlines():
    if not line.strip() or line.startswith('#'): continue
    digest,name=line.split('  ',1)
    if name in digest_map: fail(f"duplicate digest-list entry: {name}")
    digest_map[name]=digest
expected_payloads=declared-{'PACKAGE-DIGESTS.txt','PACKAGE-ROOT.sha256'}
if set(digest_map)!=expected_payloads:
    fail(f"digest list does not exactly cover all payload files: missing={sorted(expected_payloads-set(digest_map))}, extra={sorted(set(digest_map)-expected_payloads)}")
for name,expected in digest_map.items():
    actual_digest=sha256_bytes((ROOT/name).read_bytes())
    if actual_digest!=expected: fail(f"digest mismatch for {name}")
root_record=PACKAGE_ROOT.read_text(encoding='utf-8').strip().split()
if len(root_record)!=2 or root_record[1]!='PACKAGE-DIGESTS.txt': fail('invalid PACKAGE-ROOT.sha256 format')
actual_root=sha256_bytes(DIGESTS.read_bytes())
if root_record[0]!=actual_root: fail('package root mismatch')
expected=PARENT.read_text(encoding='utf-8').rstrip()+'\n\n---\n\n# Normative Annexes\n'
for name in ANNEXES: expected+='\n\n---\n\n'+(ROOT/name).read_text(encoding='utf-8').rstrip()+'\n'
if CONSOLIDATED.read_text(encoding='utf-8')!=expected: fail('consolidated artifact does not exactly match normative sources')
print('PASS: manifest file set')
print(f'PASS: digest list exactly covers {len(expected_payloads)} payload files')
print(f'PASS: {len(digest_map)} payload digests')
print(f'PASS: package root {actual_root}')
print('PASS: consolidated parent and embedded annex equality')
