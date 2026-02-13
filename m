#!/usr/bin/env python3
"""mem — Shadow memory search. Hybrid vector+FTS+SQL with RRF fusion.
Usage: mem "query" [-n 5] [-c category] [--full] [--json]"""
import json,subprocess,sys,urllib.request,argparse,os

P="/opt/homebrew/opt/postgresql@17/bin/psql"
D="shadow"
O="http://localhost:11434/api/embeddings"

def emb(q):
    try:
        r=urllib.request.urlopen(urllib.request.Request(O,json.dumps({"model":"nomic-embed-text","prompt":q}).encode(),{"Content-Type":"application/json"}),timeout=8)
        return json.loads(r.read())["embedding"]
    except:return None

def sql(q):
    r=subprocess.run([P,D,"-t","-A","-c",f"SELECT json_agg(row_to_json(sub)) FROM ({q}) sub;"],capture_output=True,text=True,timeout=15)
    x=r.stdout.strip()
    return json.loads(x) if x and x!="null" else []

def search(query,n=5,cat=None,full=False,as_json=False):
    eq=query.replace("'","''")
    w=f"AND category='{cat}'" if cat else ""
    # content field selection
    cf="content_pyramid" if not full else "content"
    cfull="content" if full else "COALESCE(content_pyramid,content)"
    
    # FTS
    fts=sql(f"SELECT id,left({cfull},800) as c,category as cat,title,summary,source_file as src FROM memories WHERE fts@@plainto_tsquery('english','{eq}') {w} ORDER BY ts_rank(fts,plainto_tsquery('english','{eq}')) DESC LIMIT 50")
    
    # Vector
    vec=[]
    e=emb(query)
    if e:
        es="["+",".join(str(x) for x in e)+"]"
        vec=sql(f"SELECT id,left({cfull},800) as c,category as cat,title,summary,source_file as src FROM memories WHERE embedding IS NOT NULL {w} ORDER BY embedding<=>'{es}'::vector LIMIT 50")
    
    # RRF fusion
    k=60;scores={};cm={}
    for i,r in enumerate(fts):rid=str(r["id"]);scores[rid]=scores.get(rid,0)+1.0/(k+i+1);cm[rid]=r
    for i,r in enumerate(vec):rid=str(r["id"]);scores[rid]=scores.get(rid,0)+1.0/(k+i+1);cm.setdefault(rid,r)
    
    ranked=sorted(scores.items(),key=lambda x:x[1],reverse=True)[:n]
    results=[]
    for rid,sc in ranked:
        r=cm[rid]
        results.append({"id":r["id"],"score":round(sc,6),"title":r.get("title",""),"summary":r.get("summary",""),"cat":r.get("cat",""),"src":r.get("src",""),"content":r["c"]})
    
    if as_json:
        print(json.dumps(results,indent=2))
    else:
        for i,r in enumerate(results):
            t=r["title"] or r["src"] or f"id:{r['id']}"
            print(f"\n{'─'*50}")
            print(f" #{i+1} {t} [{r['cat']}] score:{r['score']}")
            if r["summary"]:print(f" {r['summary'][:120]}")
            print(f"{'─'*50}")
            print(r["content"])

if __name__=="__main__":
    if len(sys.argv)<2 or sys.argv[1] in["-h","--help"]:
        print("mem — search Shadow memory\n  mem \"query\" [-n 5] [-c category] [--full] [--json]")
        sys.exit(0)
    ap=argparse.ArgumentParser()
    ap.add_argument("query",nargs="+")
    ap.add_argument("-n",type=int,default=5)
    ap.add_argument("-c","--cat",default=None)
    ap.add_argument("--full",action="store_true",help="return raw content instead of pyramid")
    ap.add_argument("--json",action="store_true")
    a=ap.parse_args()
    q=" ".join(a.query)
    # frontload soul/startup — dirty flag with timestamp
    # if last injection was <10min ago, skip (same session)
    # if older or missing, inject (new session)
    import time
    _flag="/tmp/.shadowdb-init"
    _inject=True
    try:
        if os.path.exists(_flag):
            age=time.time()-os.path.getmtime(_flag)
            if age<600:_inject=False  # <10min = same session
    except:pass
    if _inject:
        try:
            s=subprocess.run([P,D,"-t","-A","-c","SELECT content FROM startup ORDER BY key;"],capture_output=True,text=True,timeout=3)
            if s.stdout.strip():print(s.stdout.strip()+"\n")
        except:pass
    # touch the flag on every call to keep the window sliding
    try:open(_flag,"w").close()
    except:pass
    search(q,a.n,a.cat,a.full,a.json)
