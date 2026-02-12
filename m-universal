#!/usr/bin/env python3
"""m — Universal ShadowDB memory search. Supports postgres, sqlite, mysql backends."""
import argparse,json,os,sys

CFG=os.path.expanduser("~/.shadowdb.json")

def lcfg():
    if os.path.exists(CFG):
        with open(CFG) as f:return json.load(f)
    return {}

def resolve(override=None):
    c=lcfg();b=override or os.environ.get("SHADOWDB_BACKEND") or c.get("backend")
    if not b:
        import subprocess
        p=c.get("postgres",{}).get("psql_path","psql");d=c.get("postgres",{}).get("database","shadow")
        try:
            r=subprocess.run([p,d,"-t","-A","-c","SELECT 1;"],capture_output=True,text=True,timeout=3)
            if r.returncode==0:b="postgres"
        except:pass
        if not b:b="sqlite" if os.path.exists(c.get("sqlite",{}).get("db_path","shadow.db")) else "sqlite"
    b=(b or "sqlite").lower().strip()
    if b in("postgres","pg"):
        from backends.postgres import PostgresBackend;pc=c.get("postgres",{})
        return PostgresBackend(psql_path=pc.get("psql_path","/opt/homebrew/opt/postgresql@17/bin/psql"),database=pc.get("database","shadow"),embedding_url=pc.get("embedding_url","http://localhost:11434/api/embeddings"),embedding_model=pc.get("embedding_model","nomic-embed-text"))
    elif b=="sqlite":
        from backends.sqlite import SQLiteBackend;sc=c.get("sqlite",{})
        return SQLiteBackend(db_path=sc.get("db_path","shadow.db"),embedding_url=sc.get("embedding_url","http://localhost:11434/api/embeddings"),embedding_model=sc.get("embedding_model","nomic-embed-text"))
    elif b in("mysql","mariadb"):
        from backends.mysql import MySQLBackend;mc=c.get("mysql",{})
        return MySQLBackend(host=mc.get("host","localhost"),port=mc.get("port",3306),user=mc.get("user","root"),password=mc.get("password",""),database=mc.get("database","shadow"),embedding_url=mc.get("embedding_url","http://localhost:11434/api/embeddings"),embedding_model=mc.get("embedding_model","nomic-embed-text"))
    else:print(f"Unknown backend: {b}",file=sys.stderr);sys.exit(1)

def fmt(results,jout=False):
    if jout:print(json.dumps(results,indent=2));return
    for i,r in enumerate(results):
        t=r["title"] or r["src"] or f"id:{r['id']}"
        print(f"\n{'─'*50}\n #{i+1} {t} [{r['cat']}] score:{r['score']}")
        if r["summary"]:print(f" {r['summary'][:120]}")
        print(f"{'─'*50}\n{r['content']}")

if __name__=="__main__":
    if len(sys.argv)<2 or sys.argv[1] in["-h","--help"]:
        print("m — ShadowDB memory search\n  m \"query\" [-n 5] [-c category] [--full] [--json] [--backend postgres|sqlite|mysql]");sys.exit(0)
    ap=argparse.ArgumentParser();ap.add_argument("query",nargs="+");ap.add_argument("-n",type=int,default=5)
    ap.add_argument("-c","--cat",default=None);ap.add_argument("--full",action="store_true");ap.add_argument("--json",action="store_true")
    ap.add_argument("--backend",default=None)
    a=ap.parse_args();q=" ".join(a.query);be=resolve(a.backend)
    try:
        s=be.startup()
        if s:print(s+"\n")
    except:pass
    fmt(be.search(q,a.n,a.cat,a.full),a.json)
