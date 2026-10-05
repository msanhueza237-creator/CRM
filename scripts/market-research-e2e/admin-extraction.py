# Executed by run.py inside its single synthetic stack, before retiring fixture Auth.
from datetime import datetime,timezone,timedelta
status,access=http('/functions/v1/market-study/research-access',headers=hdr)
assert status==200,'Admin access list failed'
assert access['schema_version']==1 and access['usage']['jobs']==0
assert http('/functions/v1/market-study/research-access',headers={'X-Climactiva-Api-Key':KEY_A})[0]==401
assert http('/rest/v1/rpc/market_research_admin','POST',{'p_actor':admin,'p_action':'list','p_config':{}},hdr)[0] in [401,403,404]
sql("update market_extraction_policy set daily_usd=.25,pilot_usd=.25,daily_jobs=10,approved_until=now()+interval '1 hour',public_hosts=array['synthetic.example'];")
status,access=http('/functions/v1/market-study/research-access',headers=hdr);assert status==200
now=datetime.now(timezone.utc);expiry=min(now+timedelta(minutes=10),(now+timedelta(days=1)).replace(hour=0,minute=0,second=0,microsecond=0)-timedelta(seconds=1)).isoformat()
config={'request_id':'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','provider':'market-worker-e2e','skus':['SYN-A'],'expires_at':expiry,'policy':access['policy'],'secure_destination_ready':True,'confirm':'CREATE'}
assert http('/functions/v1/market-study/research-access','POST',{'action':'create','config':dict(config,confirm='NO')},hdr)[0]==409
assert http('/functions/v1/market-study/research-access','POST',{'action':'create','config':dict(config,skus=['MISSING'])},hdr)[0]==409
status,issued=http('/functions/v1/market-study/research-access','POST',{'action':'create','config':config},hdr);assert status==200,'Synthetic credential creation failed'
admin_key=issued['api_key'];admin_iid=issued['id'];research_hdr={'X-Climactiva-Api-Key':admin_key}
assert http('/functions/v1/market-study/research-access','POST',{'action':'create','config':config},hdr)[0]==409
status,access=http('/functions/v1/market-study/research-access',headers=hdr);assert status==200 and admin_key not in json.dumps(access)
assert http('/functions/v1/market-research/catalog',headers=research_hdr)[0]==200
sql(f"update profiles set active=false where id='{admin}';")
assert http('/functions/v1/market-study/research-access',headers=hdr)[0]==403
sql(f"update profiles set active=true where id='{admin}';")
mark('admin create/list via real Auth: consent, missing SKU rollback, fixed scopes, duplicate prevention, no key recovery and inactive denial')

def extraction(n=1,batch=1,revision=1,text=None):
 return {'schema_version':1,'batch_id':f'aaaaaaaa-aaaa-4aaa-8aaa-{batch:012d}','selection_revision':revision,'job_id':f'bbbbbbbb-bbbb-4bbb-8bbb-{n:012d}','provider':'market-worker-e2e','sku':'SYN-A','source':{'url':'https://synthetic.example/product','observed_at':datetime.now(timezone.utc).isoformat(),'public_product_page':True,'text':text or 'Bomba Modelo ABC. Precio 11900 CLP IVA incluido. Unidad.'}}
def extract(body):return http('/functions/v1/market-research/extract','POST',body,research_hdr)
def calls():return js('select to_json(count(*)) from fixture_provider_calls')
item=extraction();assert extract(item)[0]==503 and calls()==0
sql('update market_extraction_policy set enabled=true;')
status,policy=http('/functions/v1/market-research/extraction-policy',headers=research_hdr);assert status==200 and policy['enabled']
status,first_extract=extract(item);assert status==200 and first_extract['state']=='completed','First extraction failed'
assert first_extract['requires_review'] is True and first_extract['selection']['model']=='deepseek-flash'
assert extract(item)[1]==first_extract and calls()==1
assert extract(dict(item,source=dict(item['source'],text=item['source']['text']+' Changed.')))[0]==409 and calls()==1
sql('update market_extraction_policy set daily_jobs=1;');assert extract(extraction(2))[0]==429 and calls()==1;sql('update market_extraction_policy set daily_jobs=10,daily_usd=.000001;')
assert extract(extraction(2))[0]==429 and calls()==1;sql('update market_extraction_policy set daily_usd=.25;')
status,settings=http('/functions/v1/market-study/extraction-settings',headers=hdr);assert status==200
assert http('/functions/v1/market-study/extraction-settings','POST',{'revision':settings['policy']['revision'],'choice':'deepseek:deepseek-v4-pro'},hdr)[0]==200
assert extract(extraction(3,batch=2))[0]==409
status,pinned=extract(extraction(3));assert status==200 and pinned['selection']['model']=='deepseek-flash'
unknown_input=extraction(4,batch=2,revision=2,text='Bomba Modelo ABC Precio 11900 CLP SYNTHETIC_TIMEOUT')
status,unknown=extract(unknown_input);assert status==200 and unknown['state']=='unknown' and unknown['usage']['estimated_usd'] is None
call_count=calls();assert extract(unknown_input)[1]==unknown and calls()==call_count
assert js("select to_json(reserved_usd>0 and estimated_usd is null) from market_extraction_jobs where job_id='bbbbbbbb-bbbb-4bbb-8bbb-000000000004'")
mark('real extraction transport with simulated provider: one call, receipt replay/conflict, quotas/budget, manual model and batch pinning, unknown reservation')
pending=fixture(provider='market-worker-e2e',external_id='extracted-pending')
assert batch([pending],admin_key)[0]==200
assert js("select to_json(count(*)) from market_study_reviews r join market_study_observations o on o.id=r.observation_id where o.provider='market-worker-e2e'")==0
assert http('/functions/v1/market-study/research-access','POST',{'action':'revoke','config':{'id':admin_iid,'confirm':'REVOKE'}},hdr)[0]==200
assert extract(item)[0] in [401,403]
assert batch([pending],admin_key)[0] in [401,403]
assert calls()==call_count
mark('researcher saves pending observation only; explicit revocation blocks extraction receipts and ingestion')
del admin_key,issued
