#!/usr/bin/env python3
"""m — ShadowDB memory search + operations. Multi-backend: postgres, sqlite, mysql."""
import argparse,json,os,sys,subprocess,time

CFG=os.path.expanduser("~/.shadowdb.json")
DEFAULT_EMBEDDING_URL="http://localhost:11434/api/embeddings"
DEFAULT_EMBEDDING_MODEL="nomic-embed-text"

def lcfg():
    if os.path.exists(CFG):
        with open(CFG) as f:return json.load(f)
    return {}

def get_backend_name():
    c=lcfg();b=os.environ.get("SHADOWDB_BACKEND") or c.get("backend")
    if not b:
        # Auto-detect: try postgres config first, then sqlite file, then error
        pc=c.get("postgres",{})
        if pc.get("database"):
            try:
                r=subprocess.run([pc.get("psql_path","psql"),pc["database"],"-t","-A","-c","SELECT 1;"],capture_output=True,text=True,timeout=3)
                if r.returncode==0:return "postgres"
            except:pass
        sc=c.get("sqlite",{})
        if sc.get("db_path") and os.path.exists(os.path.expanduser(sc["db_path"])):return "sqlite"
        mc=c.get("mysql",{})
        if mc.get("database"):return "mysql"
        print("No backend configured. Set 'backend' in ~/.shadowdb.json or SHADOWDB_BACKEND env var.",file=sys.stderr);sys.exit(1)
    return b.lower().strip()

def _require(cfg, key, backend_name):
    """Get a required config key or exit with a clear message."""
    v=cfg.get(key)
    if not v:print(f"Missing required config: {backend_name}.{key} in ~/.shadowdb.json",file=sys.stderr);sys.exit(1)
    return v

def resolve(override=None):
    c=lcfg();b=override or get_backend_name()
    if b in("postgres","pg"):
        from backends.postgres import PostgresBackend;pc=c.get("postgres",{})
        return PostgresBackend(psql_path=pc.get("psql_path","psql"),database=pc.get("database"),host=pc.get("host"),port=pc.get("port"),user=pc.get("user"),password=pc.get("password"),connection_string=pc.get("connection_string"),embedding_url=pc.get("embedding_url",DEFAULT_EMBEDDING_URL),embedding_model=pc.get("embedding_model",DEFAULT_EMBEDDING_MODEL))
    elif b=="sqlite":
        from backends.sqlite import SQLiteBackend;sc=c.get("sqlite",{})
        return SQLiteBackend(db_path=_require(sc,"db_path","sqlite"),embedding_url=sc.get("embedding_url",DEFAULT_EMBEDDING_URL),embedding_model=sc.get("embedding_model",DEFAULT_EMBEDDING_MODEL))
    elif b in("mysql","mariadb"):
        from backends.mysql import MySQLBackend;mc=c.get("mysql",{})
        return MySQLBackend(host=mc.get("host","localhost"),port=mc.get("port",3306),user=_require(mc,"user","mysql"),password=mc.get("password",""),database=_require(mc,"database","mysql"),embedding_url=mc.get("embedding_url",DEFAULT_EMBEDDING_URL),embedding_model=mc.get("embedding_model",DEFAULT_EMBEDDING_MODEL))
    else:print(f"Unknown backend: {b}",file=sys.stderr);sys.exit(1)

# ── Database helpers (backend-aware) ──────────────────────────
def _pg_cmd(c,*extra):
    """Build psql command list. Supports connection_string, host/port/user, or database-only."""
    pc=c.get("postgres",{});psql=pc.get("psql_path","psql");cmd=[psql]
    cs=pc.get("connection_string")
    if cs:cmd.append(cs)
    else:
        h=pc.get("host");p=pc.get("port");u=pc.get("user")
        if h:cmd.extend(["-h",h])
        if p:cmd.extend(["-p",str(p)])
        if u:cmd.extend(["-U",u])
        cmd.append(_require(pc,"database","postgres"))
    cmd.extend(extra);return cmd

def _pg_env(c):
    """Return env dict with PGPASSWORD if configured."""
    pw=c.get("postgres",{}).get("password")
    if pw:return{**os.environ,"PGPASSWORD":pw}
    return None

def _sq_path(c):
    return os.path.expanduser(_require(c.get("sqlite",{}),"db_path","sqlite"))

def _my_args(c):
    mc=c.get("mysql",{});return mc.get("host","localhost"),_require(mc,"user","mysql"),mc.get("password",""),_require(mc,"database","mysql")

def db_cmd(sql):
    """Run SQL, return raw text. Routes to the configured backend."""
    c=lcfg();b=get_backend_name()
    if b in("postgres","pg"):
        r=subprocess.run(_pg_cmd(c,"-t","-A","-c",sql),capture_output=True,text=True,timeout=10,env=_pg_env(c))
        return r.stdout.strip()
    elif b=="sqlite":
        r=subprocess.run(["sqlite3",_sq_path(c),sql],capture_output=True,text=True,timeout=10)
        return r.stdout.strip()
    elif b in("mysql","mariadb"):
        h,u,pw,d=_my_args(c);cmd=["mysql","-u",u,"-h",h,d,"-N","-B","-e",sql]
        if pw:cmd.insert(3,f"-p{pw}")
        r=subprocess.run(cmd,capture_output=True,text=True,timeout=10)
        return r.stdout.strip()
    return ""

def db_pretty(sql):
    """Run SQL, return formatted table output. Routes to the configured backend."""
    c=lcfg();b=get_backend_name()
    if b in("postgres","pg"):
        r=subprocess.run(_pg_cmd(c,"-c",sql),capture_output=True,text=True,timeout=10,env=_pg_env(c))
        return r.stdout.strip()
    elif b=="sqlite":
        r=subprocess.run(["sqlite3","-header","-column",_sq_path(c),sql],capture_output=True,text=True,timeout=10)
        return r.stdout.strip()
    elif b in("mysql","mariadb"):
        h,u,pw,d=_my_args(c);cmd=["mysql","-u",u,"-h",h,d,"-e",sql]
        if pw:cmd.insert(3,f"-p{pw}")
        r=subprocess.run(cmd,capture_output=True,text=True,timeout=10)
        return r.stdout.strip()
    return ""

# ── SQL dialect helpers ───────────────────────────────────────
def sql_now():
    b=get_backend_name()
    if b=="sqlite":return "datetime('now')"
    return "now()"

def sql_ilike(col,pattern):
    b=get_backend_name()
    if b=="sqlite":return f"{col} LIKE '{pattern}' COLLATE NOCASE"
    return f"{col} ILIKE '{pattern}'"

def sql_left(col,n):
    b=get_backend_name()
    if b=="sqlite":return f"substr({col},1,{n})"
    return f"left({col},{n})"

def sql_array(tags):
    b=get_backend_name()
    if b in("postgres","pg"):
        if tags:return "ARRAY["+",".join(f"'{t.strip()}'" for t in tags)+"]"
        return "ARRAY[]::text[]"
    return "'" + ",".join(t.strip() for t in tags) + "'"

def sql_timestamp(col):
    b=get_backend_name()
    if b=="sqlite":return col
    return f"{col}::timestamp(0)"

def sql_interval(col, interval):
    b=get_backend_name()
    if b=="sqlite":return f"{col} > datetime('now','-{interval}')"
    return f"{col} > now()-interval '{interval}'"

def sql_coalesce_date(col):
    b=get_backend_name()
    if b=="sqlite":return f"COALESCE({col},'—')"
    return f"COALESCE({col}::text,'—')"

def sql_upsert(table, key_col, key_val, val_col, val):
    b=get_backend_name()
    esc_val=val.replace("'","''")
    if b=="sqlite":
        return f"INSERT INTO {table} ({key_col},{val_col},updated_at) VALUES ('{key_val}','{esc_val}',datetime('now')) ON CONFLICT ({key_col}) DO UPDATE SET {val_col}='{esc_val}', updated_at=datetime('now');"
    return f"INSERT INTO {table} ({key_col},{val_col},updated_at) VALUES ('{key_val}','{esc_val}',now()) ON CONFLICT ({key_col}) DO UPDATE SET {val_col}='{esc_val}', updated_at=now();"

# ── Startup injection with dirty flag + reinforce ─────────────
FLAG="/tmp/.shadowdb-init"
SESSION_GAP=600  # 10 minutes

def should_inject_startup():
    """Check if full startup should be injected (new session or stale flag)."""
    if not os.path.exists(FLAG):return True
    age=time.time()-os.path.getmtime(FLAG)
    return age>=SESSION_GAP

def touch_flag():
    """Touch the dirty flag — slides the session window forward."""
    open(FLAG,"w").close()

def get_reinforced():
    """Get reinforced rules (always injected, regardless of dirty flag).
    Only queries DB if reinforce=true in config — zero overhead otherwise."""
    c=lcfg()
    if not c.get("reinforce"):return ""
    b=get_backend_name()
    if b in("postgres","pg"):
        p,d=_pg_args(c)
        r=subprocess.run([p,d,"-t","-A","-c","SELECT content FROM startup WHERE reinforce=true ORDER BY priority, key;"],capture_output=True,text=True,timeout=3)
        return r.stdout.strip()
    elif b=="sqlite":
        r=subprocess.run(["sqlite3",_sq_path(c),"SELECT content FROM startup WHERE reinforce=1 ORDER BY priority, key;"],capture_output=True,text=True,timeout=3)
        return r.stdout.strip()
    elif b in("mysql","mariadb"):
        h,u,pw,d=_my_args(c);cmd=["mysql","-u",u,"-h",h,d,"-N","-B","-e","SELECT content FROM startup WHERE reinforce=1 ORDER BY priority, `key`;"]
        if pw:cmd.insert(3,f"-p{pw}")
        r=subprocess.run(cmd,capture_output=True,text=True,timeout=3)
        return r.stdout.strip()
    return ""

def fmt(results,jout=False):
    if jout:print(json.dumps(results,indent=2));return
    for i,r in enumerate(results):
        t=r["title"] or r["src"] or f"id:{r['id']}"
        print(f"\n{'─'*50}\n #{i+1} {t} [{r['cat']}] score:{r['score']}")
        if r["summary"]:print(f" {r['summary'][:120]}")
        print(f"{'─'*50}\n{r['content']}")

# ── Subcommand: save ──────────────────────────────────────────
def cmd_save(args):
    if len(args)<2:print('Usage: m save "title" "content" [-c category] [-t tag1,tag2]');sys.exit(1)
    title=args[0];content=args[1];cat="general";tags=[]
    i=2
    while i<len(args):
        if args[i]=="-c" and i+1<len(args):cat=args[i+1];i+=2
        elif args[i]=="-t" and i+1<len(args):tags=args[i+1].split(",");i+=2
        else:i+=1
    esc_t=title.replace("'","''");esc_c=content.replace("'","''")
    tags_sql=sql_array(tags);b=get_backend_name()
    if b in("postgres","pg"):
        result=db_cmd(f"INSERT INTO memories (title,content,category,tags,created_at) VALUES ('{esc_t}','{esc_c}','{cat}',{tags_sql},{sql_now()}) RETURNING id;")
        result=result.split("\n")[0].strip()
    elif b=="sqlite":
        db_cmd(f"INSERT INTO memories (title,content,category,tags,created_at) VALUES ('{esc_t}','{esc_c}','{cat}',{tags_sql},{sql_now()});")
        result=db_cmd("SELECT last_insert_rowid();")
    else:
        db_cmd(f"INSERT INTO memories (title,content,category,tags,created_at) VALUES ('{esc_t}','{esc_c}','{cat}',{tags_sql},{sql_now()});")
        result="?"
    print(f'Saved: id={result} title="{title}" category={cat}')

# ── Subcommand: loops ─────────────────────────────────────────
def cmd_loops(args):
    print(db_pretty(f"SELECT id, CASE WHEN nag THEN '🔴' ELSE '⚪' END as nag, {sql_coalesce_date('due_date')} as due, {sql_left('description',100)} as description FROM open_loops WHERE status='open' ORDER BY nag DESC, due_date ASC NULLS LAST;"))

# ── Subcommand: state ─────────────────────────────────────────
def cmd_state(args):
    if len(args)==0:
        print(db_pretty(f"SELECT key, {sql_left('value',120)} as value, {sql_timestamp('updated_at')} FROM session_state ORDER BY key;"))
    elif len(args)==1:
        r=db_cmd(f"SELECT value FROM session_state WHERE key='{args[0]}';")
        print(r if r else f"No key '{args[0]}'")
    else:
        db_cmd(sql_upsert("session_state","key",args[0],"value",args[1]))
        print(f"Updated: {args[0]}")

# ── Subcommand: people ────────────────────────────────────────
def cmd_people(args):
    if not args:
        print(db_pretty("SELECT name, company, role, phone, email FROM people ORDER BY name LIMIT 20;"))
    else:
        q=args[0].replace("'","''")
        print(db_pretty(f"SELECT name, company, role, phone, email, notes FROM people WHERE {sql_ilike('name',f'%{q}%')} OR {sql_ilike('company',f'%{q}%')} OR {sql_ilike('notes',f'%{q}%')};"))

# ── Subcommand: handoff ──────────────────────────────────────
def cmd_handoff(args):
    if len(args)<1:print('Usage: m handoff "focus" ["drafts"] ["decisions"]');sys.exit(1)
    db_cmd(sql_upsert("session_state","key","current_focus","value",args[0]))
    if len(args)>1:db_cmd(sql_upsert("session_state","key","pending_drafts","value",args[1]))
    if len(args)>2:db_cmd(sql_upsert("session_state","key","recent_decisions","value",args[2]))
    print("Session handoff written.")
    print(db_pretty(f"SELECT key, {sql_left('value',100)} as value FROM session_state ORDER BY key;"))

# ── Subcommand: d (daily dashboard) ──────────────────────────
def cmd_d(args):
    print("═══ SESSION STATE ═══")
    print(db_pretty(f"SELECT key, {sql_left('value',120)} as value FROM session_state ORDER BY key;"))
    print("\n═══ OPEN LOOPS ═══")
    print(db_pretty(f"SELECT id, CASE WHEN nag THEN '🔴' ELSE '⚪' END as nag, {sql_coalesce_date('due_date')} as due, {sql_left('description',100)} as description FROM open_loops WHERE status='open' ORDER BY nag DESC, due_date ASC NULLS LAST;"))
    print("\n═══ RECENT (24h) ═══")
    print(db_pretty(f"SELECT id, category, {sql_left('title',60)} as title, {sql_timestamp('created_at')} FROM memories WHERE {sql_interval('created_at','24 hours')} ORDER BY created_at DESC LIMIT 10;"))

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

    if sys.argv[1] in SUBCOMMANDS:
        SUBCOMMANDS[sys.argv[1]](sys.argv[2:]);sys.exit(0)

    ap=argparse.ArgumentParser();ap.add_argument("query",nargs="+");ap.add_argument("-n",type=int,default=5)
    ap.add_argument("-c","--cat",default=None);ap.add_argument("--full",action="store_true");ap.add_argument("--json",action="store_true")
    ap.add_argument("--backend",default=None)
    a=ap.parse_args();q=" ".join(a.query);be=resolve(a.backend)
    # Startup: full identity on new session, reinforced rules always
    if should_inject_startup():
        try:
            s=be.startup()
            if s:print(s+"\n")
        except:pass
    else:
        # Not a new session — still inject reinforced rules
        r=get_reinforced()
        if r:print(r+"\n")
    touch_flag()
    fmt(be.search(q,a.n,a.cat,a.full),a.json)
