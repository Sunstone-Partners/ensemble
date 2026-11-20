

]<]minimax[>[<invoke name="bash">]<]minimax[>[<command>cd ~/.omp/ensemble-pdf-f7-r3 && python3 - <<'PY'
prev=open('REVIEW_CODERABBIT_REPORT.md',encoding='utf-8').read()
cur=open('REVIEW_REPORT.md',encoding='utf-8').read()
def block(s):
    i=s.find('<!-- FOREMAN_REVIEW_FINDINGS_START -->')
    j=s.find('<!-- FOREMAN_REVIEW_FINDINGS_END -->')
    return s[i:j]
p=[l for l in block(prev).split('\n') if l.startswith('- ')]
c=[l for l in block(cur).split('\n') if l.startswith('- ')]
print('prev bullets',len(p),'cur bullets',len(c))
missing=[b for b in p if b not in c]
print('carried verbatim:',len(p)-len(missing),'of',len(p))
for m in missing: print('MISSING:',m[:100])
print('new bullets:',len(c)-len(p))
# check markers are last thing in file
tail=cur.rstrip().split('\n')[-1]
print('last line:',repr(tail))
PY]<]minimax[>[</cmd>]<]minimax[>[</invoke>