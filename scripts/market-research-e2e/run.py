import traceback,os,sys,json,time,subprocess,threading,signal,hashlib,hmac,base64,re,shutil,urllib.request,urllib.error,ipaddress,concurrent.futures,queue
from pathlib import Path
ROOT=Path(__file__).resolve().parent
assert ROOT.parent==Path('/tmp') and re.fullmatch(r'crm-market-e2e-[a-z0-9-]+',ROOT.name)
RUN=ROOT.name; LABEL='crm.market-e2e.run'; NET=RUN+'-net'; GIB=1024**3
IMAGES={'db':'sha256:0e2279598bc0224fb5960c3a61eb23270cd60119427f3a7bdec86ba282600dcc','rest':'sha256:ee1044a08215efa291a36ab4f773989c8c8bb7e7bbd4435d12739d9b2f7a2e09','edge':'sha256:358930e39ff36e0130c3afe3808a5c8f8322f7ff9c42624406dacce859ed0e24','kong':'sha256:1b53405d8680a09d6f44494b7990bf7da2ea43f84a258c59717d4539abf09f6d','auth':'sha256:884f1a203a6a999251492d3d7092a4077b714ef210650a85f338a84385093ea4'}
LIMITS={'db':(768,.35),'rest':(128,.10),'edge':(512,.25),'kong':(384,.20),'auth':(128,.10)}
PASSWORD='OnlySyntheticE2EPassword2026'; JWT_SECRET='market-fixture-only-not-for-production-2026-10-03-secret'; KEY_A='synthetic-research-a';KEY_B='synthetic-research-b';KEY_C='synthetic-research-c'
keyA='22222222-2222-4222-8222-222222222222';keyB='33333333-3333-4333-8333-333333333333';keyC='66666666-6666-4666-8666-666666666666'
intA='44444444-4444-4444-8444-444444444444';intB='55555555-5555-4555-8555-555555555555';intC='77777777-7777-4777-8777-777777777777'
started=time.monotonic()-max(0,time.time()-float((ROOT/'allocated_at').read_text())) if (ROOT/'allocated_at').exists() else time.monotonic();stop_monitor=threading.Event();aborted=threading.Event();abort_reasons=[];created=[];sessions=[];samples=[];base='';report={'run':RUN,'started_at':time.time(),'checks':[],'passed':False,'production_mutations':False,'limits':LIMITS,'images':IMAGES,'limitations':['Fixture router uses offline Deno.serve with the observed VERIFY_JWT=false mode; no public TLS/DNS route is created.','No production data or credentials; tests do not validate the external dot itself.']}

def redact(s):
 for secret in [PASSWORD,JWT_SECRET,KEY_A,KEY_B,KEY_C]:s=s.replace(secret,'[synthetic-redacted]')
 s=re.sub(r'ca_live_[a-fA-F0-9]+','[synthetic-key-redacted]',s)
 return re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+','[synthetic-jwt-redacted]',s)
def cmd(args,input=None,timeout=30,check=True):
 r=subprocess.run(args,input=input,capture_output=True,text=True,timeout=timeout)
 if check and r.returncode:raise RuntimeError(args[0]+' failed: '+redact(r.stderr[-1800:]))
 return r
def docker(*args,**kw):return cmd(['docker',*args],**kw)
def inspect(name):return json.loads(docker('inspect',name).stdout)[0]
def resource():
 mem={v.split(':')[0]:int(v.split()[1])*1024 for v in open('/proc/meminfo') if v.startswith('MemAvailable:')};v=os.statvfs('/var/lib/docker')
 return {'at':time.time(),'mem_available':mem['MemAvailable'],'disk_available':v.f_bavail*v.f_frsize,'load1':os.getloadavg()[0]}
def prod_states():
 ids=docker('ps','-q').stdout.split()
 if not ids:return {}
 fmt='{{.Id}}|{{.RestartCount}}|{{json .State}}'
 out={}
 for row in docker('inspect','--format',fmt,*ids).stdout.splitlines():
  ident,restarts,raw=row.split('|',2);state=json.loads(raw)
  if ident not in created:out[ident]=[state['Running'],state.get('Health',{}).get('Status','none'),state['OOMKilled'],int(restarts)]
 return out

def health():
 out={}
 for url in ['https://crm.latinchile.cl/','https://supabase.latinchile.cl/auth/v1/health','https://supabase.latinchile.cl/functions/v1/market-study/health']:
  try:r=urllib.request.urlopen(url,timeout=10);out[url]=r.status;r.close()
  except urllib.error.HTTPError as e:out[url]=e.code
  except Exception as e:out[url]=type(e).__name__
 return out
def safe_own(name):
 info=inspect(name);assert info['Config'].get('Labels',{}).get(LABEL)==RUN;assert info['Name'].lstrip('/').startswith(RUN+'-');return info
def abort(reason):
 if aborted.is_set():return
 abort_reasons.append(reason);report['abort_event']={'at':time.time(),'elapsed_seconds':round(time.monotonic()-started,3),'reason':reason};aborted.set();print('ABORT '+reason,flush=True)
 for name in list(created):
  try:safe_own(name);docker('stop','-t','2',name,timeout=8,check=False)
  except Exception:pass
def ensure():
 if aborted.is_set():raise RuntimeError('Aborted by resource/safety monitor: '+','.join(abort_reasons))
 if time.monotonic()-started>600:abort('10-minute work deadline; reserve 5 minutes cleanup');raise RuntimeError('deadline')
def mark(name,**evidence):ensure();report['checks'].append({'name':name,'passed':True,**evidence});print('PASS '+name,flush=True)
def fixture_size():
 total=0
 for directory,_,files in os.walk(ROOT):
  for name in files:
   try:total+=os.lstat(os.path.join(directory,name)).st_size
   except FileNotFoundError:pass
 return total
def monitor():
 high=0
 while not stop_monitor.wait(5):
  try:
   s=resource();s['fixture_bytes']=fixture_size()
   for ident in list(created):
    r=docker('inspect','--size',ident,check=False,timeout=8)
    if r.returncode:continue
    c=json.loads(r.stdout)[0];s['fixture_bytes']+=c.get('SizeRw',0)
    if c.get('LogPath') and os.path.exists(c['LogPath']):s['fixture_bytes']+=os.path.getsize(c['LogPath'])
    if c['State']['OOMKilled']:abort('test container OOM');return
   samples.append(s);high=high+1 if s['load1']>3.5 else 0
   if s['mem_available']<2*GIB:abort('memory below 2 GiB');return
   if s['fixture_bytes']>=GIB:abort('test disk reached 1 GiB');return
   if s['disk_available']<15*GIB:abort('host disk below 15 GiB');return
   if high>=6:
    report['load_stop_evidence']={'threshold':3.5,'consecutive_samples':high,'first_sample_at':samples[-high]['at'],'last_sample_at':s['at'],'sample_span_seconds':round(s['at']-samples[-high]['at'],3)}
    abort('load above 3.5 in six consecutive samples (~30 seconds)');return
   states=prod_states()
   for ident,state in baseline_states.items():
    if states.get(ident)!=state:abort('production container state changed');return
   ensure()
  except Exception as e:
   if not stop_monitor.is_set():abort('monitor error: '+type(e).__name__)
   return

def sql(text,db='postgres',check=True):
 ensure();return docker('exec','-i',RUN+'-db','psql','-X','-qAt','-h','/tmp','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1',input=text,check=check,timeout=35)
def q(v):return "'"+str(v).replace("'","''")+"'"
def js(text,db='postgres'):return json.loads(sql(text,db).stdout.strip().splitlines()[-1])
def http(path,method='GET',body=None,headers=None,timeout=25):
 ensure();url=base+path;assert url.startswith(base+'/');data=None if body is None else json.dumps(body).encode();hdr={'Content-Type':'application/json',**(headers or {})}
 try:r=urllib.request.urlopen(urllib.request.Request(url,data=data,headers=hdr,method=method),timeout=timeout);status=r.status;raw=r.read();r.close()
 except urllib.error.HTTPError as e:status=e.code;raw=e.read()
 try:payload=json.loads(raw)
 except Exception:payload={'non_json_bytes':len(raw)}
 report.setdefault('http_checks',[]).append({'path':path,'method':method,'status':status})
 return status,payload

def token(role):
 encode=lambda b:base64.urlsafe_b64encode(b).rstrip(b'=').decode();header=encode(b'{"alg":"HS256","typ":"JWT"}');payload=encode(json.dumps({'role':role,'iss':'supabase','iat':int(time.time()),'exp':int(time.time())+3600}).encode());data=header+'.'+payload;return data+'.'+encode(hmac.new(JWT_SECRET.encode(),data.encode(),hashlib.sha256).digest())
ANON=token('anon');SERVICE=token('service_role')
def envfile(name,values):
 p=ROOT/(name+'.env');p.write_text(''.join(k+'='+str(v)+'\n' for k,v in values.items()));p.chmod(0o600);return str(p)
def create(name,values,extra,command):
 ensure();mem,cpu=LIMITS[name];image=IMAGES[name];assert inspect_image(image)['Id']==image
 args=['create','--pull=never','--name',RUN+'-'+name,'--label',LABEL+'='+RUN,'--label','traefik.enable=false','--network',NET,'--network-alias',name,'--restart=no','--memory',str(mem)+'m','--memory-swap',str(mem)+'m','--cpus',str(cpu),'--pids-limit','128','--cap-drop=ALL','--security-opt=no-new-privileges:true','--read-only','--log-opt=max-size=5m','--log-opt=max-file=1','--tmpfs','/tmp:rw,nosuid,size=64m,mode=1777','--env-file',envfile(name,values),*extra,image,*command]
 ident=docker(*args).stdout.strip();created.append(ident);i=safe_own(ident);h=i['HostConfig'];assert not h['Privileged'] and not h.get('PortBindings') and h['NetworkMode']==NET and h['RestartPolicy']['Name']=='no';assert h['Memory']==mem*1024**2 and h['NanoCpus']==int(cpu*1e9)
 assert len(i['NetworkSettings']['Networks'])==1
 report.setdefault('owned_volumes',[]).extend(m['Name'] for m in i['Mounts'] if m['Type']=='volume')
 for m in i['Mounts']:
  if m['Type']=='bind':assert Path(m['Source']).resolve().is_relative_to(ROOT)
  assert 'docker.sock' not in m['Destination']
 docker('start',ident);return ident

def inspect_image(i):return json.loads(docker('image','inspect',i).stdout)[0]
def wait_for(check,label,seconds=90):
 until=time.monotonic()+seconds
 while time.monotonic()<until:
  ensure()
  if check():return
  time.sleep(1)
 raise RuntimeError('Timed out: '+label)

def fixture(**extra):
 x={'provider':'synthetic-a','external_id':'offer-1','revision':1,'product_label':'Synthetic pump','suggested_sku':'SYN-A','seller':'Synthetic competitor','seller_kind':'competitor','amount':119,'currency':'CLP','vat_basis':'gross','vat_percent':19,'unit':'unit','package_quantity':1,'presentation':'Unit','availability':'available','source_url':'https://example.test/offer','observed_at':'2026-10-01T00:00:00.000Z','confidence':.9,'fx':None,'notes':'Synthetic E2E data, never production.'};x.update(extra);return x
def batch(items,key=KEY_A,preview=False):return http('/functions/v1/market-research/observations'+('/preview' if preview else ''),'POST',{'schema_version':1,'observations':items},{'X-Climactiva-Api-Key':key})
def ingest(items,key=keyA):return 'select market_research_ingest('+q(key)+'::uuid,'+q(json.dumps(items))+'::jsonb);'

class Connection:
 def __init__(self):
  self.p=subprocess.Popen(['docker','exec','-i','-e','PGAPPNAME=market-e2e-control',RUN+'-db','psql','-X','-qAt','-h','/tmp','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=0'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1);self.lines=queue.Queue();self.seq=0;sessions.append(self)
  threading.Thread(target=lambda:[self.lines.put(line.rstrip()) for line in self.p.stdout],daemon=True).start();threading.Thread(target=lambda:[None for line in self.p.stderr],daemon=True).start()
 def query(self,text):
  self.seq+=1;marker='__DONE_'+str(self.seq)+'__';self.p.stdin.write(text+'\n\\echo '+marker+' :SQLSTATE\n');self.p.stdin.flush();rows=[]
  while True:
   line=self.lines.get(timeout=20)
   if line.startswith(marker+' '):return line.split()[-1],rows
   if line:rows.append(line)
 def ok(self,text):
  state,rows=self.query(text);assert state=='00000',state;return rows
 def close(self):
  if self.p.poll() is None:
   try:self.p.stdin.write('ROLLBACK;\n\\q\n');self.p.stdin.flush();self.p.wait(timeout=5)
   except Exception:self.p.kill()

def interrupted(signum,frame):raise RuntimeError('Safety timeout or disconnected execution')
signal.signal(signal.SIGALRM,interrupted);signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted);signal.alarm(max(1,int(600-(time.monotonic()-started))))
ROOT.chmod(0o755)
(ROOT/'OWNED_BY_RUN').write_text(RUN)
baseline_states={};watcher=None
try:
 baseline_states=prod_states();report['baseline_http']=health();report['baseline_production_containers']=len(baseline_states)
 report['preflight_samples']=[]
 preflight_start=time.monotonic()
 for sample_index in range(13):
  time.sleep(max(0,preflight_start+sample_index*5-time.monotonic()));pre=resource();report['preflight_samples'].append(pre)
  assert pre['load1']<=2.5 and pre['mem_available']>=4*GIB and pre['disk_available']>=20*GIB,'Preflight failed; no retry or test start'
 pre=resource();assert pre['mem_available']>=4*GIB and pre['disk_available']>=20*GIB,'Preflight resources below approval thresholds';baseline_states=prod_states();report['baseline_http']=health();assert report['baseline_http']['https://crm.latinchile.cl/']==200;report['preflight']=pre;report['baseline_production_containers']=len(baseline_states)
 assert pre['load1']<=2.5,'Preflight load exceeds the sustained-load safety threshold; do not start'
 for image in IMAGES.values():inspect_image(image)
 docker('network','create','--internal','--label',LABEL+'='+RUN,NET);n=json.loads(docker('network','inspect',NET).stdout)[0];assert n['Internal'];cidr=n['IPAM']['Config'][0]['Subnet'];report['network']={'internal':True,'subnet':cidr,'published_ports':False}
 watcher=threading.Thread(target=monitor,daemon=True);watcher.start()
 for folder in ['pgdata','artifacts']:(ROOT/folder).mkdir();os.chown(ROOT/folder,105,106);(ROOT/folder).chmod(0o700)
 (ROOT/'pg-password').write_text(PASSWORD);(ROOT/'pg-password').chmod(0o644)
 bootstrap=f"set -eu\ninitdb -D /var/lib/postgresql/data --username=postgres --pwfile=/fixtures/pg-password --auth-host=scram-sha-256 --auth-local=trust --encoding=UTF8 --no-locale\nprintf '%s\\n' 'host all all {cidr} scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf\nexec postgres -D /var/lib/postgresql/data -c listen_addresses='*' -c unix_socket_directories=/tmp -c shared_buffers=32MB -c max_connections=24 -c work_mem=4MB -c maintenance_work_mem=32MB -c min_wal_size=32MB -c max_wal_size=128MB\n"
 (ROOT/'db-start.sh').write_text(bootstrap)
 create('db',{},['--user','105:106','--entrypoint','/bin/sh','--mount',f'type=bind,src={ROOT}/pgdata,dst=/var/lib/postgresql/data','--mount',f'type=bind,src={ROOT}/artifacts,dst=/artifacts','--mount',f'type=bind,src={ROOT},dst=/fixtures,readonly'],['/fixtures/db-start.sh'])
 wait_for(lambda:docker('exec',RUN+'-db','pg_isready','-h','/tmp','-U','postgres',check=False).returncode==0,'PostgreSQL')
 sql(f"create schema extensions;create extension pgcrypto with schema extensions;create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;create role supabase_admin nologin;create role authenticator login noinherit password '{PASSWORD}';grant anon,authenticated,service_role to authenticator;create role supabase_auth_admin login createrole password '{PASSWORD}';create schema auth authorization supabase_auth_admin;alter role supabase_auth_admin set search_path=auth,public,extensions;grant usage on schema public,extensions to supabase_auth_admin;grant all on schema auth to supabase_auth_admin;grant usage on schema public,auth,extensions to anon,authenticated,service_role;alter default privileges in schema public grant all on tables to anon,authenticated,service_role;alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;")
 create('auth',{'GOTRUE_API_HOST':'0.0.0.0','GOTRUE_API_PORT':'9999','API_EXTERNAL_URL':'http://kong:8000/auth/v1','GOTRUE_SITE_URL':'http://synthetic.invalid','GOTRUE_DB_DRIVER':'postgres','GOTRUE_DB_DATABASE_URL':f'postgres://supabase_auth_admin:{PASSWORD}@db:5432/postgres','GOTRUE_JWT_SECRET':JWT_SECRET,'GOTRUE_JWT_EXP':'3600','GOTRUE_JWT_AUD':'authenticated','GOTRUE_JWT_DEFAULT_GROUP_NAME':'authenticated','GOTRUE_JWT_ADMIN_ROLES':'service_role','GOTRUE_DISABLE_SIGNUP':'false','GOTRUE_EXTERNAL_EMAIL_ENABLED':'true','GOTRUE_MAILER_AUTOCONFIRM':'true','GOTRUE_LOG_LEVEL':'error'},[],[])
 # GoTrue's real migrations must create auth.users before the CRM schema is applied.
 wait_for(lambda:js("select to_json(to_regclass('auth.users') is not null)")==True,'GoTrue migrations')
 auth_ip=safe_own(RUN+'-auth')['NetworkSettings']['Networks'][NET]['IPAddress']
 def auth_ready():
  try:
   r=urllib.request.urlopen('http://'+auth_ip+':9999/health',timeout=2);good=r.status==200;r.close();return good
  except Exception:return False
 wait_for(auth_ready,'GoTrue completed migrations')
 assert js("select to_json(to_regprocedure('auth.uid()') is not null)"),'Real auth.uid missing'

 for name in ['schema.sql','agent_hub.sql','content_center.sql','agent_api_keys.sql','market_study.sql']:sql((ROOT/'sql'/name).read_text(encoding='utf-8-sig'))
 migration=(ROOT/'sql/market_research_api.sql').read_text(encoding='utf-8-sig');sql(re.sub(r'commit;\s*$','rollback;',migration,flags=re.I));assert js("select to_json(to_regclass('market_research_integrations') is null)")
 failed=sql(re.sub(r'commit;\s*$','select 1/0;commit;',migration,flags=re.I),check=False);assert failed.returncode!=0 and js("select to_json(to_regclass('market_research_integrations') is null)")
 sql(migration);assert js('select to_json(count(*)) from market_research_integrations')==0
 sql((ROOT/'sql/prospecting_deepseek_settings.sql').read_text(encoding='utf-8-sig'))
 extraction_sql=(ROOT/'sql/market_extraction.sql').read_text(encoding='utf-8-sig')
 sql(re.sub(r'commit;\s*$','rollback;',extraction_sql,flags=re.I));assert js("select to_json(to_regclass('market_extraction_jobs') is null)")
 sql(extraction_sql);assert js('select to_json(not enabled) from market_extraction_policy')
 provider_fixture=json.loads((ROOT/'fixture-provider.json').read_text());assert provider_fixture['synthetic'] is True
 sql("insert into prospecting_ai_integrations(provider,status,models,api_key_encrypted) values('deepseek','verified','[\"deepseek-flash\",\"deepseek-v4-pro\"]',"+q(provider_fixture['cipher'])+");create table fixture_provider_calls(id bigserial primary key,called_at timestamptz default now());revoke all on fixture_provider_calls from public,anon,authenticated;revoke all on sequence fixture_provider_calls_id_seq from public,anon,authenticated;grant insert,select on fixture_provider_calls to service_role;grant usage on sequence fixture_provider_calls_id_seq to service_role;")
 mark('PG15 full relevant DDL and real pgcrypto; rollback/failure atomicity; no integration activated by migration',version=docker('exec',RUN+'-db','postgres','--version').stdout.strip())
 create('rest',{'PGRST_DB_URI':f'postgres://authenticator:{PASSWORD}@db:5432/postgres','PGRST_DB_SCHEMAS':'public','PGRST_DB_ANON_ROLE':'anon','PGRST_JWT_SECRET':JWT_SECRET,'PGRST_DB_POOL':'4','PGRST_SERVER_PORT':'3000'},[],[])
 create('edge',{'SUPABASE_URL':'http://kong:8000','SUPABASE_ANON_KEY':ANON,'SUPABASE_SERVICE_ROLE_KEY':SERVICE,'JWT_SECRET':JWT_SECRET,'VERIFY_JWT':'false','CRM_APP_URL':'http://synthetic.invalid','DENO_DIR':'/tmp/deno','XDG_CACHE_HOME':'/tmp/cache','MARKET_EXTRACTION_ENABLED':'true','MARKET_EXTRACTION_DEEPSEEK_RATE_DATE':time.strftime('%Y-%m-%d',time.gmtime()),'PROSPECTING_SECRET_ENCRYPTION_KEY':provider_fixture['encryption']},['--mount',f'type=bind,src={ROOT}/functions,dst=/home/deno/functions,readonly'],['start','--main-service','/home/deno/functions/main'])
 kong={'_format_version':'2.1','services':[{'name':'functions','url':'http://edge:9000/','routes':[{'name':'functions-all','paths':['/functions/v1/'],'strip_path':True}],'plugins':[{'name':'cors'}]},{'name':'auth','url':'http://auth:9999/','routes':[{'name':'auth-all','paths':['/auth/v1/'],'strip_path':True}]},{'name':'rest','url':'http://rest:3000/','routes':[{'name':'rest-all','paths':['/rest/v1/'],'strip_path':True}],'plugins':[{'name':'key-auth','config':{'key_names':['apikey'],'hide_credentials':False}}]}],'consumers':[{'username':'synthetic-anon','keyauth_credentials':[{'key':ANON}]},{'username':'synthetic-service','keyauth_credentials':[{'key':SERVICE}]}]}
 (ROOT/'kong.json').write_text(json.dumps(kong));create('kong',{'KONG_DATABASE':'off','KONG_DECLARATIVE_CONFIG':'/fixtures/kong.json','KONG_PROXY_LISTEN':'0.0.0.0:8000','KONG_ADMIN_LISTEN':'off','KONG_NGINX_WORKER_PROCESSES':'1','KONG_PREFIX':'/tmp/kong','KONG_LOG_LEVEL':'error','KONG_PROXY_ACCESS_LOG':'/dev/null'},['--mount',f'type=bind,src={ROOT}/kong.json,dst=/fixtures/kong.json,readonly'],[])
 ip=safe_own(RUN+'-kong')['NetworkSettings']['Networks'][NET]['IPAddress'];assert ipaddress.ip_address(ip) in ipaddress.ip_network(cidr);base='http://'+ip+':8000';report['fixture_gateway_ip']=ip
 def ready():
  try:return http('/auth/v1/health')[0]==200
  except Exception:return False
 wait_for(ready,'Kong and GoTrue health');mark('five pinned containers healthy enough for real isolated HTTP; no published ports or production mounts')
 status,user=http('/auth/v1/admin/users','POST',{'email':'synthetic-admin@example.test','password':PASSWORD,'email_confirm':True,'role':'authenticated'},{'Authorization':'Bearer '+SERVICE,'apikey':SERVICE});assert status in [200,201],('create synthetic user',status);admin=user['id']
 status,session=http('/auth/v1/token?grant_type=password','POST',{'email':'synthetic-admin@example.test','password':PASSWORD},{'apikey':ANON});assert status==200,('synthetic login',status);USER_JWT=session['access_token']
 claims=json.loads(base64.urlsafe_b64decode(USER_JWT.split('.')[1]+'=='));assert claims.get('role')=='authenticated','Fixture login must carry the actual authenticated database role'
 sql(f"insert into profiles(id,full_name,role,active) values('{admin}','Synthetic E2E admin','administrador',true);insert into content_products(source_provider,external_id,payload_hash,sku,name,brand,price,stock,variants) values('tiendanube','e2e-a','synthetic','SYN-A','Synthetic A','Synthetic',999,10,'[{{\"sku\":\"VAR-A\",\"price\":888}}]'),('tiendanube','e2e-b','synthetic','SYN-B','Synthetic B','Synthetic',777,3,'[]');")
 for key,secret in [(keyA,KEY_A),(keyB,KEY_B),(keyC,KEY_C)]:sql(f"insert into agent_api_keys(id,name,key_prefix,key_hash,scopes,expires_at) values('{key}','Synthetic key',{q(secret)},encode(extensions.digest({q(secret)},'sha256'),'hex'),array['market-research:catalog:read','market-research:observations:write'],now()+interval '1 hour');")
 for ident,key,provider,sku in [(intA,keyA,'synthetic-a',['SYN-A','VAR-A']),(intB,keyB,'synthetic-b',['SYN-B']),(intC,keyC,'synthetic-c',['SYN-A'])]:sql(f"insert into market_research_integrations(id,api_key_id,provider,allowed_skus,active,authorized_by,expires_at) values('{ident}','{key}',{q(provider)},array[{','.join(map(q,sku))}],true,'{admin}',now()+interval '1 hour');")
 wait_for(lambda:http('/rest/v1/market_research_integrations?select=id',headers={'apikey':SERVICE,'Authorization':'Bearer '+SERVICE})[0]==200,'PostgREST schema cache')
 before_prices=js('select jsonb_agg(to_jsonb(p) order by sku) from content_products p')
 assert http('/functions/v1/market-research/catalog')[0]==401
 assert http('/functions/v1/market-research/catalog',headers={'Authorization':'Bearer '+USER_JWT})[0]==401
 assert http('/functions/v1/market-research/catalog',headers={'X-Climactiva-Api-Key':'invalid-synthetic'})[0]==401
 status,catalog=http('/functions/v1/market-research/catalog',headers={'X-Climactiva-Api-Key':KEY_A});assert status==200,('catalog',status,catalog);assert [r['sku'] for r in catalog['items']]==['SYN-A','VAR-A'];assert all(set(r)=={'sku','name','brand','product_url','catalog_observed_at'} for r in catalog['items'])
 assert http('/functions/v1/market-research/catalog',headers={'X-Climactiva-Api-Key':KEY_B})[1]['items'][0]['sku']=='SYN-B'
 mark('real GoTrue login plus key-only API authentication and isolated catalog whitelist')
 assert batch([fixture()],preview=True)[0]==200;assert js('select to_json(count(*)) from market_study_observations')==0
 status,first=batch([fixture()]);assert status==200 and first['inserted']==1,(status,first);assert batch([fixture()])[1]['duplicates']==1
 assert batch([fixture(amount=120)])[0]==409;assert batch([fixture(external_id='new-atomic'),fixture(amount=122)])[0]==409;assert js("select to_json(count(*)) from market_study_observations where external_id='new-atomic'")==0
 assert batch([fixture(suggested_sku='SYN-B')])[0]==403;assert batch([fixture(provider='synthetic-b')])[0]==403;assert batch([fixture(approved=True)])[0]==422
 for route in ['reviews','bootstrap','prices']:assert http('/functions/v1/market-research/'+route,headers={'X-Climactiva-Api-Key':KEY_A})[0]==404
 for path in ['/rest/v1/market_research_integrations?select=*','/rest/v1/market_study_observations?select=*']:assert http(path,headers={'apikey':ANON,'Authorization':'Bearer '+USER_JWT})[0] in [401,403]
 mark('real PostgREST RPC validation, preview, atomic idempotence and denied cross-provider/SKU/direct table access')
 for change in ["active=false","expires_at=now()-interval '1 second'","scopes=array['crm:read']"]:
  sql(f"update agent_api_keys set {change} where id='{keyA}';");assert http('/functions/v1/market-research/catalog',headers={'X-Climactiva-Api-Key':KEY_A})[0]==401;sql(f"update agent_api_keys set active=true,expires_at=now()+interval '1 hour',scopes=array['market-research:catalog:read','market-research:observations:write'] where id='{keyA}';")
 sql(f"update market_research_integrations set active=false where id='{intA}';");assert batch([fixture()])[0]==403;sql(f"update market_research_integrations set active=true where id='{intA}';")
 mark('real expired/disabled/insufficient-scope keys and disabled integration fail closed')
 hdr={'Authorization':'Bearer '+USER_JWT,'apikey':ANON};status,view=http('/functions/v1/market-study/bootstrap',headers=hdr);assert status==200,('admin bootstrap',status,view);assert view['observations'][0]['created_by']=='API '+intA;assert not view['reviews']
 review={'observation_id':first['receipts'][0]['observation_id'],'request_id':'88888888-8888-4888-8888-888888888888','expected_review_id':None,'decision':'approved','product_key':'current:SYN-A','sku':'SYN-A','unit':'unit','internal_quantity':1,'equivalence_confirmed':True,'cost_basis_confirmed':True,'internal_fx':None,'reason':'Synthetic human reviewed model and units.'}
 assert http('/functions/v1/market-study/reviews','POST',review,hdr)[0]==200;assert batch([fixture(revision=2,amount=120)])[0]==200
 status,view=http('/functions/v1/market-study/bootstrap',headers=hdr);assert status==200;latest=next(r for r in view['observations'] if r['payload']['revision']==2);assert not any(r['observation_id']==latest['id'] for r in view['reviews']);assert view['reviews'][0]['created_by']==admin
 sql(f"update profiles set active=false where id='{admin}';");assert http('/functions/v1/market-study/bootstrap',headers=hdr)[0]==403;assert batch([fixture()])[0]==403;sql(f"update profiles set active=true where id='{admin}';")
 mark('real administrator JWT, backend permissions, human review and unverified next revision')
 exec(compile((ROOT/'admin-extraction.py').read_text(),str(ROOT/'admin-extraction.py'),'exec'),globals())
 safe_own(RUN+'-auth');docker('stop','-t','5',RUN+'-auth');mark('phase A done; fixture Auth stopped, no new initialization')
 control=Connection();pid=int(control.ok('select pg_backend_pid();')[-1]);waits=[]
 def blocked():
  until=time.monotonic()+10
  while time.monotonic()<until:
   rows=js(f"select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'blockers',pg_blocking_pids(pid),'wait_event',wait_event)), '[]'::jsonb) from pg_stat_activity where {pid}=any(pg_blocking_pids(pid));")
   if rows:waits.extend(rows);return
   time.sleep(.1)
  raise RuntimeError('No real blocking observed')
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
  for identity,patch,commit,expected in [('concurrent-same',{},True,200),('concurrent-conflict',{'amount':121},True,409),('concurrent-rollback',{},False,200)]:
   control.ok('begin;set local role service_role;'+ingest([fixture(external_id=identity)]));future=pool.submit(batch,[fixture(external_id=identity,**patch)]);blocked();control.ok('commit;' if commit else 'rollback;');r=future.result(timeout=20);assert r[0]==expected,(identity,r[0]);assert r[1].get('duplicates' if commit else 'inserted')==1 if expected==200 else True
  sql("insert into market_study_observations(provider,external_id,revision,payload,origin_integration_id,origin_api_key_id) select 'synthetic-c','quota-'||n,1,jsonb_set("+q(json.dumps(fixture(provider='synthetic-c')))+"::jsonb,'{external_id}',to_jsonb('quota-'||n)),'"+intC+"','"+keyC+"' from generate_series(1,999) n;")
  control.ok('begin;set local role service_role;'+ingest([fixture(provider='synthetic-c',external_id='quota-winner')],keyC));future=pool.submit(batch,[fixture(provider='synthetic-c',external_id='quota-loser')],KEY_C);blocked();control.ok('commit;');assert future.result(timeout=20)[0]==429;assert batch([fixture(provider='synthetic-c',external_id='quota-winner')],KEY_C)[1]['duplicates']==1
  control.ok(f"begin;select pg_advisory_xact_lock(hashtextextended('{intB}',37));");future=pool.submit(batch,[fixture(provider='synthetic-b',suggested_sku='SYN-B',external_id='revoked-wait')],KEY_B);blocked();sql(f"select revoke_agent_api_key('{keyB}');");control.ok('commit;');assert future.result(timeout=20)[0]==403
 report['concurrent_waits']=waits;mark('five real PostgREST/HTTP wait races: duplicate, conflict, rollback, quota and revocation',control_pid=pid)
 tables=['public.content_products','public.profiles','public.market_study_observations','public.market_study_reviews','public.market_research_integrations','auth.users','auth.sessions','auth.refresh_tokens','public.agent_api_keys','public.market_extraction_policy','public.market_extraction_policy_history','public.market_extraction_batches','public.market_extraction_jobs']
 def fingerprints(db='postgres'):return {t:js("select jsonb_build_object('count',count(*),'hash',md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by to_jsonb(t)::text),''))) from "+t+' t;',db) for t in tables}
 # Quiesce only fixture auth to freeze token/session housekeeping while taking the snapshot.
 control.close()
 for component in ['edge','rest','kong']:
  safe_own(RUN+'-'+component);docker('stop','-t','5',RUN+'-'+component)
 original=fingerprints()
 docker('exec',RUN+'-db','pg_dump','-h','/tmp','-U','postgres','-d','postgres','-Fc','-f','/artifacts/synthetic.dump',timeout=45)
 sql('create database synthetic_restore;');docker('exec',RUN+'-db','pg_restore','-h','/tmp','-U','postgres','-d','synthetic_restore','--exit-on-error','/artifacts/synthetic.dump',timeout=45);assert fingerprints('synthetic_restore')==original
 report['restore_comparison']=original;report['backup_bytes']=(ROOT/'artifacts/synthetic.dump').stat().st_size
 mark('pg_dump 15.8 / pg_restore into separate synthetic DB: all thirteen table fingerprints match')
 assert js('select jsonb_agg(to_jsonb(p) order by sku) from content_products p')==before_prices;mark('catalog/own prices unchanged; no automatic equivalence approval')
 report['passed']=True
except Exception as e:
 report['traceback']=redact(traceback.format_exc());report['error']=redact(type(e).__name__+': '+str(e));print('FAIL '+report['error'],flush=True)
 for ident in list(created):
  try:
   c=safe_own(ident);logs=docker('logs','--tail','12',ident,check=False).stderr+docker('logs','--tail','12',ident,check=False).stdout
   report.setdefault('fixture_diagnostics',[]).append({'name':c['Name'],'state':c['State']['Status'],'oom':c['State']['OOMKilled'],'logs':redact(logs[-2400:])})
  except Exception:pass
finally:
 signal.alarm(300);stop_monitor.set()
 if watcher:watcher.join(timeout=12)
 for s in sessions:
  try:s.close()
  except Exception:pass
 report['abort_reasons']=abort_reasons;report['resources']=samples
 removal=[]
 for ident in docker('ps','-aq','--filter','label='+LABEL+'='+RUN,check=False).stdout.split():
  try:safe_own(ident);r=docker('rm','-f','-v',ident,check=False,timeout=15);removal.append({'id':ident,'removed':r.returncode==0})
  except Exception as e:removal.append({'id':ident,'removed':False,'error':type(e).__name__})
 net=docker('network','inspect',NET,check=False)
 if net.returncode==0:
  info=json.loads(net.stdout)[0];assert info.get('Labels',{}).get(LABEL)==RUN;assert not info.get('Containers');docker('network','rm',NET)
 remaining=docker('ps','-aq','--filter','label='+LABEL+'='+RUN,check=False).stdout.strip();network_left=docker('network','ls','-q','--filter','label='+LABEL+'='+RUN,check=False).stdout.strip()
 left_volumes=[v for v in report.get('owned_volumes',[]) if docker('volume','inspect',v,check=False).returncode==0]
 report['cleanup']={'remaining_volumes':left_volumes,'containers':removal,'remaining_containers':remaining,'remaining_networks':network_left,'no_published_ports_created':True}
 try:
  report['final_http']=health();final=prod_states();report['production_unchanged']=all(final.get(k)==v for k,v in baseline_states.items()) and report.get('baseline_http')==report['final_http'];report['final_resources']=resource()
 except Exception as error:report['production_unchanged']=False;report['final_check_error']=type(error).__name__
 report['duration_seconds']=round(time.monotonic()-started,2)
 if not remaining and not network_left and not left_volumes and (ROOT/'OWNED_BY_RUN').read_text()==RUN and ROOT.resolve().parent==Path('/tmp'):
  shutil.rmtree(ROOT);report['cleanup']['temporary_files_removed']=not ROOT.exists()
 else:report['cleanup']['temporary_files_removed']=False
 report['passed']=report['passed'] and report['production_unchanged'] and report['cleanup']['temporary_files_removed'] and not aborted.is_set()
 signal.alarm(0)
 print('E2E_REPORT_BASE64='+base64.b64encode(json.dumps(report).encode()).decode(),flush=True)
 sys.exit(0 if report['passed'] else 1)
