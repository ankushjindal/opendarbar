#!/opt/homebrew/bin/python3
"""Export Dia (Chromium) cookies for chosen hosts to a Netscape cookies.txt.
Key: macOS keychain 'Dia Safe Storage' -> PBKDF2-SHA1(saltysalt, 1003, 16) -> AES-128-CBC, iv = 16 spaces.
Chromium >= v24 prefixes the plaintext with sha256(host_key); stripped when present.
Usage: export-dia-cookies.py <profile dir> <out.txt> [host-substr ...]   (default hosts: youtube.com google.com x.com twitter.com)
Never prints values or the key. Writes 0600."""
import sqlite3, subprocess, sys, hashlib, os, shutil, tempfile
prof, out = sys.argv[1], sys.argv[2]; hosts = sys.argv[3:] or ["youtube.com","google.com","x.com","twitter.com"]
pw = subprocess.run(['security','find-generic-password','-s','Dia Safe Storage','-w'],capture_output=True,text=True,check=True).stdout.strip()
key = hashlib.pbkdf2_hmac('sha1', pw.encode(), b'saltysalt', 1003, 16)
tmp = tempfile.mktemp(suffix='.db'); shutil.copy(os.path.join(prof,'Cookies'), tmp)   # copy: Dia keeps it locked
db = sqlite3.connect(tmp); rows = db.execute("select host_key,path,is_secure,expires_utc,name,encrypted_value from cookies").fetchall(); db.close(); os.remove(tmp)
lines=["# Netscape HTTP Cookie File"]; n=0
for host,path,sec,exp,name,enc in rows:
    if not any(h in host for h in hosts) or enc[:3]!=b'v10': continue
    r = subprocess.run(['openssl','enc','-d','-aes-128-cbc','-K',key.hex(),'-iv',(b' '*16).hex()],input=enc[3:],capture_output=True)
    if r.returncode!=0: continue
    raw = r.stdout
    if len(raw)>32 and raw[:32]==hashlib.sha256(host.encode()).digest(): raw = raw[32:]
    val = raw.decode('utf8','ignore'); exp_unix = max(0,int(exp/1000000 - 11644473600)) if exp else 0
    lines.append("\t".join([host,"TRUE" if host.startswith('.') else "FALSE",path,"TRUE" if sec else "FALSE",str(exp_unix),name,val])); n+=1
fd = os.open(out, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600); os.write(fd, ("\n".join(lines)+"\n").encode()); os.close(fd)
print(f"cookies exported: {n} -> {out}")
