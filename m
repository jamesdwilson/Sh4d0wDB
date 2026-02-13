#!/usr/bin/env python3
"""m — Universal ShadowDB memory search + operations. Supports postgres, sqlite, mysql backends."""
import argparse,json,os,sys,subprocess

CFG=os.path.expanduser("~/.shadowdb.json")

def lcfg():
    if os.path.exists(CFG):
        with open(CFG) as f:return json.load(f)
    return {}

def resolve(override=None):
    c=lcfg();b=override or os.environ.get("SHADOWDB_BACKEND") or c.get("backend")
    if not b:
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

def psql_cmd(sql, db="shadow"):
    """Direct psql execution for subcommands."""
    c=lcfg();p=c.get("postgres",{}).get("psql_path","/opt/homebrew/opt/postgresql@17/bin/psql")
    d=c.get("postgres",{}).get("database",db)
    r=subprocess.run([p,d,"-t","-A","-c",sql],capture_output=True,text=True,timeout=10)
    return r.stdout.strip()

def psql_pretty(sql, db="shadow"):
    """Direct psql execution with formatted output."""
    c=lcfg();p=c.get("postgres",{}).get("psql_path","/opt/homebrew/opt/postgresql@17/bin/psql")
    d=c.get("postgres",{}).get("database",db)
    r=subprocess.run([p,d,"-c",sql],capture_output=True,text=True,timeout=10)
    return r.stdout.strip()

def fmt(results,jout=False):
    if jout:print(json.dumps(results,indent=2));return
    for i,r in enumerate(results):
        t=r["title"] or r["src"] or f"id:{r['id']}"
        print(f"\n{'─'*50}\n #{i+1} {t} [{r['cat']}] score:{r['score']}")
        if r["summary"]:print(f" {r['summary'][:120]}")
        print(f"{'─'*50}\n{r['content']}")

# ── Subcommand: save ──────────────────────────────────────────
def cmd_save(args):
    """m save "title" "content" [-c category] [-t tag1,tag2]"""
    title=args[0] if len(args)>0 else None
    content=args[1] if len(args)>1 else None
    if not title or not content:
        print("Usage: m save \"title\" \"content\" [-c category] [-t tag1,tag2]");sys.exit(1)
    cat="general";tags=[]
    i=2
    while i<len(args):
        if args[i]=="-c" and i+1<len(args):cat=args[i+1];i+=2
        elif args[i]=="-t" and i+1<len(args):tags=args[i+1].split(",");i+=2
        else:i+=1
    esc_title=title.replace("'","''")
    esc_content=content.replace("'","''")
    tags_sql="ARRAY["+",".join(f"'{t.strip()}'" for t in tags)+"]" if tags else "ARRAY[]::text[]"
    sql=f"INSERT INTO memories (title,content,category,tags,created_at) VALUES ('{esc_title}','{esc_content}','{cat}',{tags_sql},now()) RETURNING id;"
    result=psql_cmd(sql)
    print(f"Saved: id={result} title=\"{title}\" category={cat}")

# ── Subcommand: loops ─────────────────────────────────────────
def cmd_loops(args):
    """m loops — show open loops/nags"""
    print(psql_pretty("SELECT id, CASE WHEN nag THEN '🔴' ELSE '⚪' END as nag, COALESCE(due_date::text,'—') as due, left(description,100) as description FROM open_loops WHERE status='open' ORDER BY nag DESC, due_date ASC NULLS LAST;"))

# ── Subcommand: state ─────────────────────────────────────────
def cmd_state(args):
    """m state [key] [value] — read/write session_state"""
    if len(args)==0:
        print(psql_pretty("SELECT key, left(value,120) as value, updated_at::timestamp(0) FROM session_state ORDER BY key;"))
    elif len(args)==1:
        r=psql_cmd(f"SELECT value FROM session_state WHERE key='{args[0]}';")
        print(r if r else f"No key '{args[0]}'")
    else:
        esc_val=args[1].replace("'","''")
        psql_cmd(f"INSERT INTO session_state (key,value,updated_at) VALUES ('{args[0]}','{esc_val}',now()) ON CONFLICT (key) DO UPDATE SET value='{esc_val}', updated_at=now();")
        print(f"Updated: {args[0]}")

# ── Subcommand: people ────────────────────────────────────────
def cmd_people(args):
    """m people [name] — lookup or list people"""
    if not args:
        print(psql_pretty("SELECT name, company, role, phone, email FROM people ORDER BY name LIMIT 20;"))
    else:
        q=args[0].replace("'","''")
        print(psql_pretty(f"SELECT name, company, role, phone, email, notes FROM people WHERE name ILIKE '%{q}%' OR company ILIKE '%{q}%' OR notes ILIKE '%{q}%';"))

# ── Subcommand: handoff ──────────────────────────────────────
def cmd_handoff(args):
    """m handoff "focus" "drafts" "decisions" — write session handoff in one call"""
    if len(args)<1:
        print("Usage: m handoff \"current focus\" [\"pending drafts\"] [\"recent decisions\"]");sys.exit(1)
    focus=args[0].replace("'","''")
    drafts=args[1].replace("'","''") if len(args)>1 else ""
    decisions=args[2].replace("'","''") if len(args)>2 else ""
    psql_cmd(f"INSERT INTO session_state (key,value,updated_at) VALUES ('current_focus','{focus}',now()) ON CONFLICT (key) DO UPDATE SET value='{focus}', updated_at=now();")
    if drafts:psql_cmd(f"INSERT INTO session_state (key,value,updated_at) VALUES ('pending_drafts','{drafts}',now()) ON CONFLICT (key) DO UPDATE SET value='{drafts}', updated_at=now();")
    if decisions:psql_cmd(f"INSERT INTO session_state (key,value,updated_at) VALUES ('recent_decisions','{decisions}',now()) ON CONFLICT (key) DO UPDATE SET value='{decisions}', updated_at=now();")
    print("Session handoff written.")
    print(psql_pretty("SELECT key, left(value,100) as value FROM session_state ORDER BY key;"))

# ── Subcommand: d (daily dashboard) ──────────────────────────
def cmd_d(args):
    """m d — daily dashboard: state + loops + recent saves"""
    print("═══ SESSION STATE ═══")
    print(psql_pretty("SELECT key, left(value,120) as value FROM session_state ORDER BY key;"))
    print("\n═══ OPEN LOOPS ═══")
    print(psql_pretty("SELECT id, CASE WHEN nag THEN '🔴' ELSE '⚪' END as nag, COALESCE(due_date::text,'—') as due, left(description,100) as description FROM open_loops WHERE status='open' ORDER BY nag DESC, due_date ASC NULLS LAST;"))
    print("\n═══ RECENT (24h) ═══")
    print(psql_pretty("SELECT id, category, left(title,60) as title, created_at::timestamp(0) FROM memories WHERE created_at > now()-interval '24 hours' ORDER BY created_at DESC LIMIT 10;"))

SUBCOMMANDS={"save":cmd_save,"loops":cmd_loops,"state":cmd_state,"people":cmd_people,"handoff":cmd_handoff,"d":cmd_d}

if __name__=="__main__":
    if len(sys.argv)<2 or sys.argv[1] in["-h","--help"]:
        print("""m — ShadowDB memory search + operations

  SEARCH:   m "query" [-n 5] [-c category] [--full] [--json]
  SAVE:     m save "title" "content" [-c category] [-t tag1,tag2]
  LOOPS:    m loops                     — open nags/deadlines
  STATE:    m state [key] [value]       — read/write session state
  PEOPLE:   m people [name]             — contact lookup
  HANDOFF:  m handoff "focus" ["drafts"] ["decisions"]
  DASH:     m d                         — daily dashboard (state+loops+recent)""");sys.exit(0)

    # Subcommands bypass startup (no ops dump)
    if sys.argv[1] in SUBCOMMANDS:
        SUBCOMMANDS[sys.argv[1]](sys.argv[2:]);sys.exit(0)

    # Default: search (with startup on first call)
    ap=argparse.ArgumentParser();ap.add_argument("query",nargs="+");ap.add_argument("-n",type=int,default=5)
    ap.add_argument("-c","--cat",default=None);ap.add_argument("--full",action="store_true");ap.add_argument("--json",action="store_true")
    ap.add_argument("--backend",default=None)
    a=ap.parse_args();q=" ".join(a.query);be=resolve(a.backend)
    try:
        s=be.startup()
        if s:print(s+"\n")
    except:pass
    fmt(be.search(q,a.n,a.cat,a.full),a.json)
