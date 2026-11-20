import subprocess

BT = chr(96)
ESC = chr(92) + BT

def show(ref, path):
    txt = subprocess.run(["git", "show", ref + ":" + path], capture_output=True, text=True).stdout
    print(ref, path, "lines:", len(txt.splitlines()), "escaped-backtick lines:", txt.count(ESC))
    return txt

for path in ["docs/TRD/permitter.md", "packages/permitter/README.md", "packages/permitter/CHANGELOG.md"]:
    for ref in ["dev", "HEAD"]:
        show(ref, path)

wt = open("docs/TRD/permitter.md").read()
print("WORKTREE docs/TRD/permitter.md escaped-backtick lines:", wt.count(ESC))
for i, line in enumerate(wt.splitlines(), 1):
    if ESC in line:
        print(i, repr(line[:120]))
