import re,sys,subprocess,os,tempfile
h=open(sys.argv[1]).read(); bad=0
for i,m in enumerate(re.finditer(r'<script([^>]*)>(.*?)</script>',h,re.S)):
    attrs,body=m.group(1),m.group(2)
    if 'src=' in attrs or not body.strip() or 'importmap' in attrs or 'json' in attrs: continue
    ext='.mjs' if 'module' in attrs else '.js'
    f=tempfile.NamedTemporaryFile('w',suffix=ext,delete=False); f.write(body); f.close()
    r=subprocess.run(['node','--check',f.name],capture_output=True,text=True)
    line=h[:m.start()].count('\n')+1
    print(f'script#{i} line {line} {ext} {"OK" if r.returncode==0 else "FAIL"}')
    if r.returncode: bad+=1; print(r.stderr[:800])
    os.unlink(f.name)
sys.exit(1 if bad else 0)
