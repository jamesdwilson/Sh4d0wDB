#!/usr/bin/env python3
"""mem — Shadow memory search. Hybrid vector+FTS+SQL with RRF fusion."""
import json,subprocess,sys,urllib.request,argparse,os,time

P="/opt/homebrew/opt/postgresql@17/bin/psql"
D="shadow"
O="http://localhost:11434/api/embeddings"
F="/tmp/.shadowdb-init"
G=600

def emb(q):
    try:
        r=urllib.request.urlopen(urllib.request.Request(O,json.dumps({"model":"nomic-embed-text","prompt":q}).encode(),{"Content-Type":"application/json"}),timeout=8)
        return json.loads(r.read())["embedding"]
    except:return None

def sql(q):
    r=subprocess.run([P,D,"-t","-A","-c",f"SELECT json_agg(row_to_json(sub)) FROM ({q}) sub;"],capture_output=True,text=True,timeout=15)
    x=r.stdout.strip()
    return json.loads(x) if x and x!="null" else []

def search(q,n=5,cat=None,full=False,jout=False):
    eq=q.replace("'","''")
    w=f"AND category='{cat}'" if cat else ""
    cf="content" if full else "COALESCE(content_pyramid,content)"
    fts=sql(f"SELECT id,left({cf},800) as c,category as cat,title,summary,source_file as src FROM memories WHERE fts@@plainto_tsquery('english','{eq}') {w} ORDER BY ts_rank(fts,plainto_tsquery('english','{eq}')) DESC LIMIT 50")
    vec=[]
    e=emb(q)
    if e:
        es="["+",".join(str(x) for x in e)+"]"
        vec=sql(f"SELECT id,left({cf},800) as c,category as cat,title,summary,source_file as src FROM memories WHERE embedding IS NOT NULL {w} ORDER BY embedding<=>'{es}'::vector LIMIT 50")
    k=60;sc={};cm={}
    for i,r in enumerate(fts):rid=str(r["id"]);sc[rid]=sc.get(rid,0)+1.0/(k+i+1);cm[rid]=r
    for i,r in enumerate(vec):rid=str(r["id"]);sc[rid]=sc.get(rid,0)+1.0/(k+i+1);cm.setdefault(rid,r)
    ranked=sorted(sc.items(),key=lambda x:x[1],reverse=True)[:n]
    res=[{"id":cm[rid]["id"],"score":round(s,6),"title":cm[rid].get("title",""),"summary":cm[rid].get("summary",""),"cat":cm[rid].get("cat",""),"src":cm[rid].get("src",""),"content":cm[rid]["c"]} for rid,s in ranked]
    if jout:print(json.dumps(res,indent=2))
    else:
        for i,r in enumerate(res):
            t=r["title"] or r["src"] or f"id:{r['id']}"
            print(f"\n{'─'*50}\n #{i+1} {t} [{r['cat']}] score:{r['score']}")
            if r["summary"]:print(f" {r['summary'][:120]}")
            print(f"{'─'*50}\n{r['content']}")

if __name__=="__main__":
    if len(sys.argv)<2 or sys.argv[1] in["-h","--help"]:
        print("mem — search Shadow memory\n  mem \"query\" [-n 5] [-c category] [--full] [--json]");sys.exit(0)
    ap=argparse.ArgumentParser();ap.add_argument("query",nargs="+");ap.add_argument("-n",type=int,default=5)
    ap.add_argument("-c","--cat",default=None);ap.add_argument("--full",action="store_true");ap.add_argument("--json",action="store_true")
    a=ap.parse_args();q=" ".join(a.query)
    inj=True
    try:
        if os.path.exists(F) and time.time()-os.path.getmtime(F)<G:inj=False
    except:pass
    if inj:
        try:
            s=subprocess.run([P,D,"-t","-A","-c","SELECT content FROM startup ORDER BY key;"],capture_output=True,text=True,timeout=3)
            if s.stdout.strip():print(s.stdout.strip()+"\n")
        except:pass
    try:open(F,"w").close()
    except:pass
    search(q,a.n,a.cat,a.full,a.json)
