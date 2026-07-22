-- Clima Activa CRM - prospeccion comercial controlada por el CRM
--
-- Migracion aditiva e idempotente. Ejecutar despues de schema.sql (o
-- setup_climactiva_crm_demo.sql) y, para usar la Edge Function, despues de
-- agent_api_keys.sql. No crea llaves ni habilita conectores externos.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Catalogo geografico CUT (Chile, 16 regiones / 346 comunas)
-- Los codigos se guardan como texto y con cero inicial cuando corresponde.
-- ---------------------------------------------------------------------------

create table if not exists public.geo_regions (
  code text primary key,
  name text not null unique,
  aliases text[] not null default '{}',
  sort_order smallint not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint geo_regions_code_format check (code ~ '^[0-9]{2}$')
);

create table if not exists public.geo_comunas (
  code text primary key,
  region_code text not null references public.geo_regions(code),
  name text not null,
  aliases text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint geo_comunas_code_format check (code ~ '^[0-9]{5}$'),
  unique (region_code, name)
);

create index if not exists geo_comunas_region_idx on public.geo_comunas(region_code, name);

insert into public.geo_regions (code, name, aliases, sort_order) values
  ('15', 'Arica y Parinacota', array['Region de Arica y Parinacota'], 1),
  ('01', 'Tarapaca', array['Tarapacá', 'Region de Tarapaca'], 2),
  ('02', 'Antofagasta', array['Region de Antofagasta'], 3),
  ('03', 'Atacama', array['Region de Atacama'], 4),
  ('04', 'Coquimbo', array['Region de Coquimbo'], 5),
  ('05', 'Valparaiso', array['Valparaíso', 'Region de Valparaiso'], 6),
  ('13', 'Metropolitana de Santiago', array['Region Metropolitana', 'RM', 'Santiago'], 7),
  ('06', 'Libertador General Bernardo O''Higgins', array['O''Higgins', 'Region de O''Higgins'], 8),
  ('07', 'Maule', array['Region del Maule'], 9),
  ('16', 'Nuble', array['Ñuble', 'Region de Nuble'], 10),
  ('08', 'Biobio', array['Biobío', 'Region del Biobio'], 11),
  ('09', 'La Araucania', array['La Araucanía', 'Araucania'], 12),
  ('14', 'Los Rios', array['Los Ríos', 'Region de Los Rios'], 13),
  ('10', 'Los Lagos', array['Region de Los Lagos'], 14),
  ('11', 'Aysen del General Carlos Ibanez del Campo', array['Aysén', 'Aisen'], 15),
  ('12', 'Magallanes y de la Antartica Chilena', array['Magallanes', 'Antártica Chilena'], 16)
on conflict (code) do update set
  name = excluded.name,
  aliases = excluded.aliases,
  sort_order = excluded.sort_order,
  active = true;

insert into public.geo_comunas (code, region_code, name, aliases) values
  ('15101','15','Arica','{}'), ('15102','15','Camarones','{}'),
  ('15201','15','Putre','{}'), ('15202','15','General Lagos','{}'),
  ('01101','01','Iquique','{}'), ('01107','01','Alto Hospicio','{}'),
  ('01401','01','Pozo Almonte','{}'), ('01402','01','Camina',array['Camiña']),
  ('01403','01','Colchane','{}'), ('01404','01','Huara','{}'), ('01405','01','Pica','{}'),
  ('02101','02','Antofagasta','{}'), ('02102','02','Mejillones','{}'),
  ('02103','02','Sierra Gorda','{}'), ('02104','02','Taltal','{}'),
  ('02201','02','Calama','{}'), ('02202','02','Ollague',array['Ollagüe']),
  ('02203','02','San Pedro de Atacama','{}'), ('02301','02','Tocopilla','{}'),
  ('02302','02','Maria Elena',array['María Elena']),
  ('03101','03','Copiapo',array['Copiapó']), ('03102','03','Caldera','{}'),
  ('03103','03','Tierra Amarilla','{}'), ('03201','03','Chanaral',array['Chañaral']),
  ('03202','03','Diego de Almagro','{}'), ('03301','03','Vallenar','{}'),
  ('03302','03','Alto del Carmen','{}'), ('03303','03','Freirina','{}'), ('03304','03','Huasco','{}'),
  ('04101','04','La Serena','{}'), ('04102','04','Coquimbo','{}'), ('04103','04','Andacollo','{}'),
  ('04104','04','La Higuera','{}'), ('04105','04','Paiguano','{}'), ('04106','04','Vicuna',array['Vicuña']),
  ('04201','04','Illapel','{}'), ('04202','04','Canela','{}'), ('04203','04','Los Vilos','{}'),
  ('04204','04','Salamanca','{}'), ('04301','04','Ovalle','{}'), ('04302','04','Combarbala',array['Combarbalá']),
  ('04303','04','Monte Patria','{}'), ('04304','04','Punitaqui','{}'), ('04305','04','Rio Hurtado',array['Río Hurtado']),
  ('05101','05','Valparaiso',array['Valparaíso']), ('05102','05','Casablanca','{}'),
  ('05103','05','Concon',array['Concón']), ('05104','05','Juan Fernandez',array['Juan Fernández']),
  ('05105','05','Puchuncavi',array['Puchuncaví']), ('05107','05','Quintero','{}'),
  ('05109','05','Vina del Mar',array['Viña del Mar']), ('05201','05','Isla de Pascua',array['Rapa Nui']),
  ('05301','05','Los Andes','{}'), ('05302','05','Calle Larga','{}'), ('05303','05','Rinconada','{}'),
  ('05304','05','San Esteban','{}'), ('05401','05','La Ligua','{}'), ('05402','05','Cabildo','{}'),
  ('05403','05','Papudo','{}'), ('05404','05','Petorca','{}'), ('05405','05','Zapallar','{}'),
  ('05501','05','Quillota','{}'), ('05502','05','La Calera',array['Calera']), ('05503','05','Hijuelas','{}'),
  ('05504','05','La Cruz','{}'), ('05506','05','Nogales','{}'), ('05601','05','San Antonio','{}'),
  ('05602','05','Algarrobo','{}'), ('05603','05','Cartagena','{}'), ('05604','05','El Quisco','{}'),
  ('05605','05','El Tabo','{}'), ('05606','05','Santo Domingo','{}'), ('05701','05','San Felipe','{}'),
  ('05702','05','Catemu','{}'), ('05703','05','Llay-Llay',array['Llaillay']), ('05704','05','Panquehue','{}'),
  ('05705','05','Putaendo','{}'), ('05706','05','Santa Maria',array['Santa María']),
  ('05801','05','Quilpue',array['Quilpué']), ('05802','05','Limache','{}'),
  ('05803','05','Olmue',array['Olmué']), ('05804','05','Villa Alemana','{}'),
  ('06101','06','Rancagua','{}'), ('06102','06','Codegua','{}'), ('06103','06','Coinco','{}'),
  ('06104','06','Coltauco','{}'), ('06105','06','Donihue',array['Doñihue']), ('06106','06','Graneros','{}'),
  ('06107','06','Las Cabras','{}'), ('06108','06','Machali',array['Machalí']), ('06109','06','Malloa','{}'),
  ('06110','06','Mostazal','{}'), ('06111','06','Olivar','{}'), ('06112','06','Peumo','{}'),
  ('06113','06','Pichidegua','{}'), ('06114','06','Quinta de Tilcoco','{}'), ('06115','06','Rengo','{}'),
  ('06116','06','Requinoa',array['Requínoa']), ('06117','06','San Vicente','{}'),
  ('06201','06','Pichilemu','{}'), ('06202','06','La Estrella','{}'), ('06203','06','Litueche','{}'),
  ('06204','06','Marchigue',array['Marchihue']), ('06205','06','Navidad','{}'), ('06206','06','Paredones','{}'),
  ('06301','06','San Fernando','{}'), ('06302','06','Chepica',array['Chépica']),
  ('06303','06','Chimbarongo','{}'), ('06304','06','Lolol','{}'), ('06305','06','Nancagua','{}'),
  ('06306','06','Palmilla','{}'), ('06307','06','Peralillo','{}'), ('06308','06','Placilla','{}'),
  ('06309','06','Pumanque','{}'), ('06310','06','Santa Cruz','{}'),
  ('07101','07','Talca','{}'), ('07102','07','Constitucion',array['Constitución']),
  ('07103','07','Curepto','{}'), ('07104','07','Empedrado','{}'), ('07105','07','Maule','{}'),
  ('07106','07','Pelarco','{}'), ('07107','07','Pencahue','{}'), ('07108','07','Rio Claro',array['Río Claro']),
  ('07109','07','San Clemente','{}'), ('07110','07','San Rafael','{}'),
  ('07201','07','Cauquenes','{}'), ('07202','07','Chanco','{}'), ('07203','07','Pelluhue','{}'),
  ('07301','07','Curico',array['Curicó']), ('07302','07','Hualane',array['Hualañé']),
  ('07303','07','Licanten',array['Licantén']), ('07304','07','Molina','{}'), ('07305','07','Rauco','{}'),
  ('07306','07','Romeral','{}'), ('07307','07','Sagrada Familia','{}'), ('07308','07','Teno','{}'),
  ('07309','07','Vichuquen',array['Vichuquén']), ('07401','07','Linares','{}'),
  ('07402','07','Colbun',array['Colbún']), ('07403','07','Longavi',array['Longaví']), ('07404','07','Parral','{}'),
  ('07405','07','Retiro','{}'), ('07406','07','San Javier','{}'), ('07407','07','Villa Alegre','{}'),
  ('07408','07','Yerbas Buenas','{}'),
  ('16101','16','Chillan',array['Chillán']), ('16102','16','Bulnes','{}'),
  ('16103','16','Chillan Viejo',array['Chillán Viejo']), ('16104','16','El Carmen','{}'),
  ('16105','16','Pemuco','{}'), ('16106','16','Pinto','{}'), ('16107','16','Quillon',array['Quillón']),
  ('16108','16','San Ignacio','{}'), ('16109','16','Yungay','{}'), ('16201','16','Quirihue','{}'),
  ('16202','16','Cobquecura','{}'), ('16203','16','Coelemu','{}'), ('16204','16','Ninhue','{}'),
  ('16205','16','Portezuelo','{}'), ('16206','16','Ranquil',array['Ránquil']), ('16207','16','Treguaco','{}'),
  ('16301','16','San Carlos','{}'), ('16302','16','Coihueco','{}'), ('16303','16','Niquen',array['Ñiquén']),
  ('16304','16','San Fabian',array['San Fabián']), ('16305','16','San Nicolas',array['San Nicolás']),
  ('08101','08','Concepcion',array['Concepción']), ('08102','08','Coronel','{}'),
  ('08103','08','Chiguayante','{}'), ('08104','08','Florida','{}'), ('08105','08','Hualqui','{}'),
  ('08106','08','Lota','{}'), ('08107','08','Penco','{}'), ('08108','08','San Pedro de la Paz','{}'),
  ('08109','08','Santa Juana','{}'), ('08110','08','Talcahuano','{}'), ('08111','08','Tome',array['Tomé']),
  ('08112','08','Hualpen',array['Hualpén']), ('08201','08','Lebu','{}'), ('08202','08','Arauco','{}'),
  ('08203','08','Canete',array['Cañete']), ('08204','08','Contulmo','{}'), ('08205','08','Curanilahue','{}'),
  ('08206','08','Los Alamos',array['Los Álamos']), ('08207','08','Tirua',array['Tirúa']),
  ('08301','08','Los Angeles',array['Los Ángeles']), ('08302','08','Antuco','{}'),
  ('08303','08','Cabrero','{}'), ('08304','08','Laja','{}'), ('08305','08','Mulchen',array['Mulchén']),
  ('08306','08','Nacimiento','{}'), ('08307','08','Negrete','{}'), ('08308','08','Quilaco','{}'),
  ('08309','08','Quilleco','{}'), ('08310','08','San Rosendo','{}'),
  ('08311','08','Santa Barbara',array['Santa Bárbara']), ('08312','08','Tucapel','{}'),
  ('08313','08','Yumbel','{}'), ('08314','08','Alto Biobio',array['Alto Biobío']),
  ('09101','09','Temuco','{}'), ('09102','09','Carahue','{}'), ('09103','09','Cunco','{}'),
  ('09104','09','Curarrehue','{}'), ('09105','09','Freire','{}'), ('09106','09','Galvarino','{}'),
  ('09107','09','Gorbea','{}'), ('09108','09','Lautaro','{}'), ('09109','09','Loncoche','{}'),
  ('09110','09','Melipeuco','{}'), ('09111','09','Nueva Imperial','{}'),
  ('09112','09','Padre Las Casas',array['Padre las Casas']), ('09113','09','Perquenco','{}'),
  ('09114','09','Pitrufquen',array['Pitrufquén']), ('09115','09','Pucon',array['Pucón']),
  ('09116','09','Saavedra','{}'), ('09117','09','Teodoro Schmidt','{}'),
  ('09118','09','Tolten',array['Toltén']), ('09119','09','Vilcun',array['Vilcún']),
  ('09120','09','Villarrica','{}'), ('09121','09','Cholchol','{}'), ('09201','09','Angol','{}'),
  ('09202','09','Collipulli','{}'), ('09203','09','Curacautin',array['Curacautín']),
  ('09204','09','Ercilla','{}'), ('09205','09','Lonquimay','{}'), ('09206','09','Los Sauces','{}'),
  ('09207','09','Lumaco','{}'), ('09208','09','Puren',array['Purén']), ('09209','09','Renaico','{}'),
  ('09210','09','Traiguen',array['Traiguén']), ('09211','09','Victoria','{}'),
  ('14101','14','Valdivia','{}'), ('14102','14','Corral','{}'), ('14103','14','Lanco','{}'),
  ('14104','14','Los Lagos','{}'), ('14105','14','Mafil',array['Máfil']),
  ('14106','14','Mariquina','{}'), ('14107','14','Paillaco','{}'), ('14108','14','Panguipulli','{}'),
  ('14201','14','La Union',array['La Unión']), ('14202','14','Futrono','{}'),
  ('14203','14','Lago Ranco','{}'), ('14204','14','Rio Bueno',array['Río Bueno']),
  ('10101','10','Puerto Montt','{}'), ('10102','10','Calbuco','{}'),
  ('10103','10','Cochamo',array['Cochamó']), ('10104','10','Fresia','{}'),
  ('10105','10','Frutillar','{}'), ('10106','10','Los Muermos','{}'),
  ('10107','10','Llanquihue','{}'), ('10108','10','Maullin',array['Maullín']),
  ('10109','10','Puerto Varas','{}'), ('10201','10','Castro','{}'), ('10202','10','Ancud','{}'),
  ('10203','10','Chonchi','{}'), ('10204','10','Curaco de Velez',array['Curaco de Vélez']),
  ('10205','10','Dalcahue','{}'), ('10206','10','Puqueldon',array['Puqueldón']),
  ('10207','10','Queilen',array['Queilén']), ('10208','10','Quellon',array['Quellón']),
  ('10209','10','Quemchi','{}'), ('10210','10','Quinchao','{}'), ('10301','10','Osorno','{}'),
  ('10302','10','Puerto Octay','{}'), ('10303','10','Purranque','{}'), ('10304','10','Puyehue','{}'),
  ('10305','10','Rio Negro',array['Río Negro']), ('10306','10','San Juan de la Costa','{}'),
  ('10307','10','San Pablo','{}'), ('10401','10','Chaiten',array['Chaitén']),
  ('10402','10','Futaleufu',array['Futaleufú']), ('10403','10','Hualaihue',array['Hualaihué']),
  ('10404','10','Palena','{}'),
  ('11101','11','Coyhaique',array['Coihaique']), ('11102','11','Lago Verde','{}'),
  ('11201','11','Aysen',array['Aysén']), ('11202','11','Cisnes','{}'), ('11203','11','Guaitecas','{}'),
  ('11301','11','Cochrane','{}'), ('11302','11','O''Higgins','{}'), ('11303','11','Tortel','{}'),
  ('11401','11','Chile Chico','{}'), ('11402','11','Rio Ibanez',array['Río Ibáñez']),
  ('12101','12','Punta Arenas','{}'), ('12102','12','Laguna Blanca','{}'),
  ('12103','12','Rio Verde',array['Río Verde']), ('12104','12','San Gregorio','{}'),
  ('12201','12','Cabo de Hornos',array['Cabo de Hornos (Ex Navarino)']),
  ('12202','12','Antartica',array['Antártica']), ('12301','12','Porvenir','{}'),
  ('12302','12','Primavera','{}'), ('12303','12','Timaukel','{}'), ('12401','12','Natales','{}'),
  ('12402','12','Torres del Paine','{}'),
  ('13101','13','Santiago','{}'), ('13102','13','Cerrillos','{}'), ('13103','13','Cerro Navia','{}'),
  ('13104','13','Conchali',array['Conchalí']), ('13105','13','El Bosque','{}'),
  ('13106','13','Estacion Central',array['Estación Central']), ('13107','13','Huechuraba','{}'),
  ('13108','13','Independencia','{}'), ('13109','13','La Cisterna','{}'), ('13110','13','La Florida','{}'),
  ('13111','13','La Granja','{}'), ('13112','13','La Pintana','{}'), ('13113','13','La Reina','{}'),
  ('13114','13','Las Condes','{}'), ('13115','13','Lo Barnechea','{}'), ('13116','13','Lo Espejo','{}'),
  ('13117','13','Lo Prado','{}'), ('13118','13','Macul','{}'), ('13119','13','Maipu',array['Maipú']),
  ('13120','13','Nunoa',array['Ñuñoa']), ('13121','13','Pedro Aguirre Cerda','{}'),
  ('13122','13','Penalolen',array['Peñalolén']), ('13123','13','Providencia','{}'),
  ('13124','13','Pudahuel','{}'), ('13125','13','Quilicura','{}'), ('13126','13','Quinta Normal','{}'),
  ('13127','13','Recoleta','{}'), ('13128','13','Renca','{}'), ('13129','13','San Joaquin',array['San Joaquín']),
  ('13130','13','San Miguel','{}'), ('13131','13','San Ramon',array['San Ramón']), ('13132','13','Vitacura','{}'),
  ('13201','13','Puente Alto','{}'), ('13202','13','Pirque','{}'),
  ('13203','13','San Jose de Maipo',array['San José de Maipo']), ('13301','13','Colina','{}'),
  ('13302','13','Lampa','{}'), ('13303','13','Tiltil','{}'), ('13401','13','San Bernardo','{}'),
  ('13402','13','Buin','{}'), ('13403','13','Calera de Tango','{}'), ('13404','13','Paine','{}'),
  ('13501','13','Melipilla','{}'), ('13502','13','Alhue',array['Alhué']),
  ('13503','13','Curacavi',array['Curacaví']), ('13504','13','Maria Pinto',array['María Pinto']),
  ('13505','13','San Pedro','{}'), ('13601','13','Talagante','{}'), ('13602','13','El Monte','{}'),
  ('13603','13','Isla de Maipo','{}'), ('13604','13','Padre Hurtado','{}'),
  ('13605','13','Penaflor',array['Peñaflor'])
on conflict (code) do update set
  region_code = excluded.region_code,
  name = excluded.name,
  aliases = excluded.aliases,
  active = true;

-- ---------------------------------------------------------------------------
-- Modelo de prospeccion
-- ---------------------------------------------------------------------------

alter table public.companies add column if not exists region_code text;
alter table public.companies add column if not exists comuna_code text;

-- El contrato compartido con el worker admite como maximo 50 terminos de
-- hasta 200 caracteres. Se exige que lleguen ya recortados y que no existan
-- duplicados por mayusculas/minusculas para que la expansion de tareas sea
-- determinista.
create or replace function public.prospecting_keywords_valid(p_keywords text[])
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select p_keywords is not null
    and cardinality(p_keywords) between 1 and 50
    and not exists (
      select 1
      from unnest(p_keywords) value
      where value is null
         or value <> btrim(value)
         or length(value) not between 1 and 200
    )
    and cardinality(p_keywords) = (
      select count(distinct lower(value))::integer
      from unnest(p_keywords) value
    )
$$;

do $$ begin
  alter table public.companies add constraint companies_region_code_fk
    foreign key (region_code) references public.geo_regions(code) not valid;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.companies add constraint companies_comuna_code_fk
    foreign key (comuna_code) references public.geo_comunas(code) not valid;
exception when duplicate_object then null; end $$;

create table if not exists public.prospecting_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  sector text not null default 'hvac',
  keywords text[] not null default array['climatizacion','aire acondicionado','refrigeracion','hvac'],
  sources text[] not null default array['google_places','brave_search','official_website'],
  region_codes text[] not null default '{}',
  comuna_codes text[] not null default '{}',
  target_types text[] not null default array['distribuidor','tienda comercial','tecnico','instalador grande','competencia','otro'],
  version integer not null default 1,
  result_limit_per_query integer not null default 20,
  candidate_limit integer not null default 1000,
  status text not null default 'draft',
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prospecting_campaign_name_not_empty check (length(trim(name)) between 1 and 200),
  constraint prospecting_campaign_sector_v1 check (sector = 'hvac'),
  constraint prospecting_campaign_status_check check (status in ('draft','active','archived')),
  constraint prospecting_campaign_version_check check (version >= 1),
  constraint prospecting_campaign_result_limit check (result_limit_per_query between 1 and 20),
  constraint prospecting_campaign_candidate_limit check (candidate_limit between 1 and 1000),
  constraint prospecting_campaign_keywords_not_empty check (cardinality(keywords) > 0),
  constraint prospecting_campaign_keywords_contract_check check (public.prospecting_keywords_valid(keywords)),
  constraint prospecting_campaign_sources_allowed check (sources <@ array['google_places','brave_search','official_website']::text[]),
  constraint prospecting_campaign_brave_requires_official check (
    not ('brave_search' = any(sources)) or 'official_website' = any(sources)
  ),
  constraint prospecting_campaign_target_types_allowed check (
    cardinality(target_types) > 0
    and target_types <@ array['distribuidor','tienda comercial','tecnico','instalador grande','competencia','otro']::text[]
  )
);

create table if not exists public.prospecting_runs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.prospecting_campaigns(id) on delete cascade,
  status text not null default 'pending',
  snapshot jsonb not null,
  requested_by uuid references public.profiles(id) on delete set null,
  claimed_by_api_key uuid,
  claimed_by_worker text,
  lease_token uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  claim_count integer not null default 0,
  total_tasks integer not null default 0,
  completed_tasks integer not null default 0,
  failed_tasks integer not null default 0,
  candidates_found integer not null default 0,
  progress jsonb not null default '{}'::jsonb,
  last_error text,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prospecting_run_status_check check (status in ('pending','running','partial','completed','failed','cancel_requested','cancelled')),
  constraint prospecting_run_snapshot_object check (jsonb_typeof(snapshot) = 'object')
);

create table if not exists public.prospecting_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.prospecting_runs(id) on delete cascade,
  source text not null,
  keyword text not null,
  region_code text not null references public.geo_regions(code),
  comuna_code text not null references public.geo_comunas(code),
  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  results_found integer not null default 0,
  results_discarded integer not null default 0,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prospecting_task_status_check check (status in ('pending','running','completed','failed','cancelled')),
  constraint prospecting_task_attempts_check check (attempts >= 0 and max_attempts between 1 and 10),
  unique (run_id, source, keyword, comuna_code)
);

create table if not exists public.prospect_entities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_normalized text not null,
  legal_name text,
  rut text,
  rut_normalized text,
  business_line text,
  company_type text,
  website text,
  domain_normalized text,
  phone text,
  phone_normalized text,
  email text,
  description text,
  relevance_score numeric(5,2),
  duplicate_of_entity_id uuid references public.prospect_entities(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prospect_entity_name_not_empty check (length(trim(name)) > 0),
  constraint prospect_entity_score_check check (relevance_score is null or relevance_score between 0 and 100)
);

create table if not exists public.prospect_locations (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.prospect_entities(id) on delete cascade,
  kind text not null default 'branch',
  region_code text not null references public.geo_regions(code),
  comuna_code text not null references public.geo_comunas(code),
  address text,
  address_normalized text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  phone text,
  email text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prospect_location_kind_check check (kind in ('headquarters','branch')),
  constraint prospect_location_lat_check check (latitude is null or latitude between -90 and 90),
  constraint prospect_location_lng_check check (longitude is null or longitude between -180 and 180)
);

create table if not exists public.prospecting_campaign_candidates (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.prospecting_campaigns(id) on delete cascade,
  run_id uuid not null references public.prospecting_runs(id) on delete cascade,
  entity_id uuid not null references public.prospect_entities(id) on delete cascade,
  candidate_snapshot jsonb not null default '{}'::jsonb,
  external_candidate_id text,
  possible_duplicate_of text,
  possible_duplicate_company_id uuid references public.companies(id) on delete set null,
  review_status text not null default 'pending',
  score numeric(5,2),
  company_id uuid references public.companies(id) on delete set null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint prospect_candidate_review_status_check check (review_status in ('pending','possible_duplicate','approved','rejected','linked')),
  constraint prospect_candidate_score_check check (score is null or score between 0 and 100),
  unique (run_id, entity_id)
);

-- Compatible con instalaciones que aplicaron una revision anterior del
-- modulo antes de incorporar el snapshot historico del candidato.
alter table public.prospecting_campaign_candidates
  add column if not exists candidate_snapshot jsonb not null default '{}'::jsonb;

create table if not exists public.prospect_source_records (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.prospect_entities(id) on delete cascade,
  run_id uuid references public.prospecting_runs(id) on delete set null,
  location_id uuid references public.prospect_locations(id) on delete set null,
  provider text not null,
  provider_record_id text,
  source_url text,
  field_name text not null,
  field_value text,
  confidence numeric(5,4),
  observed_at timestamptz not null,
  retention_until timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint prospect_source_locator_check check (source_url is not null or provider_record_id is not null),
  constraint prospect_source_field_not_empty check (length(trim(field_name)) > 0),
  constraint prospect_source_confidence_check check (confidence is null or confidence between 0 and 1)
);

create table if not exists public.prospecting_events (
  id uuid primary key default gen_random_uuid(),
  external_event_id text,
  run_id uuid not null references public.prospecting_runs(id) on delete cascade,
  task_id uuid references public.prospecting_tasks(id) on delete set null,
  level text not null default 'info',
  stage text not null,
  message text not null,
  metrics jsonb not null default '{}'::jsonb,
  source text,
  keyword text,
  comuna_code text references public.geo_comunas(code),
  created_at timestamptz not null default now(),
  constraint prospect_event_level_check check (level in ('debug','info','warning','error')),
  constraint prospect_event_stage_not_empty check (length(trim(stage)) > 0),
  constraint prospect_event_message_not_empty check (length(trim(message)) > 0)
);

create table if not exists public.company_locations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  source_prospect_location_id uuid references public.prospect_locations(id) on delete set null,
  kind text not null default 'branch',
  region_code text references public.geo_regions(code),
  comuna_code text references public.geo_comunas(code),
  address text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  phone text,
  email text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint company_location_kind_check check (kind in ('headquarters','branch'))
);

create table if not exists public.prospecting_api_idempotency (
  api_key_id uuid not null,
  operation text not null,
  idempotency_key text not null,
  request_hash text not null,
  state text not null default 'processing',
  response_status integer,
  response_body jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  primary key (api_key_id, operation, idempotency_key),
  constraint prospecting_idempotency_state_check check (state in ('processing','completed'))
);

create table if not exists public.prospecting_retention_audits (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  provider text not null,
  records_deleted integer not null,
  oldest_observed_at timestamptz,
  newest_observed_at timestamptz,
  purged_at timestamptz not null default now(),
  constraint prospecting_retention_deleted_check check (records_deleted > 0)
);

-- Convergencia para bases que probaron revisiones tempranas del modulo. Los
-- CREATE TABLE IF NOT EXISTS no agregan columnas nuevas a una tabla existente.
alter table public.prospecting_campaigns add column if not exists target_types text[] not null
  default array['distribuidor','tienda comercial','tecnico','instalador grande','competencia','otro'];
alter table public.prospecting_campaigns add column if not exists version integer not null default 1;
alter table public.prospecting_campaigns add column if not exists result_limit_per_query integer not null default 20;
alter table public.prospecting_campaigns add column if not exists candidate_limit integer not null default 1000;
alter table public.prospecting_campaigns add column if not exists updated_by uuid references public.profiles(id) on delete set null;

alter table public.prospecting_runs add column if not exists claimed_by_api_key uuid;
alter table public.prospecting_runs add column if not exists claimed_by_worker text;
alter table public.prospecting_runs add column if not exists lease_token uuid;
alter table public.prospecting_runs add column if not exists lease_expires_at timestamptz;
alter table public.prospecting_runs add column if not exists heartbeat_at timestamptz;
alter table public.prospecting_runs add column if not exists claim_count integer not null default 0;
alter table public.prospecting_runs add column if not exists completed_tasks integer not null default 0;
alter table public.prospecting_runs add column if not exists failed_tasks integer not null default 0;
alter table public.prospecting_runs add column if not exists candidates_found integer not null default 0;
alter table public.prospecting_runs add column if not exists progress jsonb not null default '{}'::jsonb;
alter table public.prospecting_runs add column if not exists cancel_requested_at timestamptz;

alter table public.prospecting_tasks add column if not exists attempts integer not null default 0;
alter table public.prospecting_tasks add column if not exists max_attempts integer not null default 3;
alter table public.prospecting_tasks add column if not exists results_found integer not null default 0;
alter table public.prospecting_tasks add column if not exists results_discarded integer not null default 0;
alter table public.prospecting_tasks add column if not exists last_error text;
alter table public.prospecting_tasks add column if not exists started_at timestamptz;
alter table public.prospecting_tasks add column if not exists completed_at timestamptz;

alter table public.prospecting_campaign_candidates add column if not exists candidate_snapshot jsonb not null default '{}'::jsonb;
alter table public.prospecting_campaign_candidates add column if not exists external_candidate_id text;
alter table public.prospecting_campaign_candidates add column if not exists possible_duplicate_of text;
alter table public.prospecting_campaign_candidates add column if not exists possible_duplicate_company_id uuid references public.companies(id) on delete set null;
alter table public.prospecting_campaign_candidates add column if not exists company_id uuid references public.companies(id) on delete set null;
alter table public.prospecting_campaign_candidates add column if not exists reviewed_by uuid references public.profiles(id) on delete set null;
alter table public.prospecting_campaign_candidates add column if not exists reviewed_at timestamptz;
alter table public.prospecting_campaign_candidates add column if not exists review_notes text;

alter table public.prospect_source_records add column if not exists run_id uuid references public.prospecting_runs(id) on delete set null;
alter table public.prospect_source_records add column if not exists location_id uuid references public.prospect_locations(id) on delete set null;
alter table public.prospect_source_records add column if not exists retention_until timestamptz;
alter table public.prospect_source_records add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.prospect_source_records add column if not exists first_seen_at timestamptz not null default now();
alter table public.prospect_source_records add column if not exists last_seen_at timestamptz not null default now();

alter table public.prospecting_events add column if not exists external_event_id text;
alter table public.prospecting_events add column if not exists source text;
alter table public.prospecting_events add column if not exists keyword text;
alter table public.prospecting_events add column if not exists comuna_code text references public.geo_comunas(code);
alter table public.company_locations add column if not exists source_prospect_location_id uuid references public.prospect_locations(id) on delete set null;

-- Converge datos de revisiones anteriores antes de instalar la restriccion:
-- recorta, limita a 200 caracteres, conserva la primera variante de cada
-- termino (case-insensitive) y aplica el maximo de 50.
with normalized as (
  select campaign.id,
         coalesce((
           select array_agg(deduplicated.keyword order by deduplicated.first_position)
           from (
             select (array_agg(prepared.keyword order by prepared.position))[1] keyword,
                    min(prepared.position) first_position
             from (
               select left(btrim(raw.keyword), 200) keyword, raw.position
               from unnest(campaign.keywords) with ordinality raw(keyword, position)
               where raw.keyword is not null and btrim(raw.keyword) <> ''
             ) prepared
             group by lower(prepared.keyword)
             order by min(prepared.position)
             limit 50
           ) deduplicated
         ), array['hvac']::text[]) keywords
  from public.prospecting_campaigns campaign
  where not public.prospecting_keywords_valid(campaign.keywords)
)
update public.prospecting_campaigns campaign
set keywords = normalized.keywords
from normalized
where campaign.id = normalized.id;

update public.prospecting_campaigns
set target_types = array['distribuidor','tienda comercial','tecnico','instalador grande','competencia','otro']
where cardinality(target_types) = 0;

-- Brave permite descubrir sitios, pero no acredita por si solo el domicilio.
-- Las definiciones antiguas se vuelven ejecutables agregando el enriquecedor
-- oficial antes de instalar la restriccion para futuras escrituras.
update public.prospecting_campaigns
set sources = array_append(sources, 'official_website')
where 'brave_search' = any(sources)
  and not ('official_website' = any(sources));

do $$ begin
  alter table public.prospecting_campaigns add constraint prospecting_campaign_name_length_check
    check (length(trim(name)) between 1 and 200);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.prospecting_campaigns add constraint prospecting_campaign_keywords_contract_check
    check (public.prospecting_keywords_valid(keywords));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.prospecting_campaigns add constraint prospecting_campaign_target_types_runtime_check
    check (
      cardinality(target_types) > 0
      and target_types <@ array['distribuidor','tienda comercial','tecnico','instalador grande','competencia','otro']::text[]
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.prospecting_campaigns add constraint prospecting_campaign_brave_requires_official_runtime_check
    check (not ('brave_search' = any(sources)) or 'official_website' = any(sources));
exception when duplicate_object then null; end $$;

create index if not exists prospecting_campaigns_status_idx on public.prospecting_campaigns(status, created_at desc);
create index if not exists prospecting_runs_claim_idx on public.prospecting_runs(status, lease_expires_at, created_at);
create index if not exists prospecting_runs_campaign_idx on public.prospecting_runs(campaign_id, created_at desc);
create index if not exists prospecting_tasks_run_status_idx on public.prospecting_tasks(run_id, status);
create index if not exists prospect_entities_name_idx on public.prospect_entities(name_normalized);
create unique index if not exists prospect_entities_rut_unique on public.prospect_entities(rut_normalized) where rut_normalized is not null;
create unique index if not exists prospect_entities_domain_unique on public.prospect_entities(domain_normalized) where domain_normalized is not null;
create unique index if not exists prospect_entities_phone_unique on public.prospect_entities(phone_normalized) where phone_normalized is not null;
create index if not exists prospect_locations_entity_idx on public.prospect_locations(entity_id);
create unique index if not exists prospect_locations_exact_unique on public.prospect_locations(entity_id, comuna_code, coalesce(address_normalized, ''));
create unique index if not exists prospect_locations_one_primary on public.prospect_locations(entity_id) where is_primary;
create index if not exists prospecting_candidates_review_idx on public.prospecting_campaign_candidates(review_status, last_seen_at desc);
create index if not exists prospecting_candidates_campaign_idx on public.prospecting_campaign_candidates(campaign_id, run_id);
create unique index if not exists prospecting_candidates_external_id_unique on public.prospecting_campaign_candidates(run_id, external_candidate_id) where external_candidate_id is not null;
-- La evidencia pertenece a una ejecucion. Una repeticion de la campana no
-- puede actualizar ni trasladar la evidencia observada por un run anterior.
drop index if exists public.prospect_source_provider_record_unique;
create unique index prospect_source_provider_record_unique
  on public.prospect_source_records(run_id, provider, provider_record_id, field_name)
  where run_id is not null and provider_record_id is not null;
create index if not exists prospect_source_run_entity_idx
  on public.prospect_source_records(run_id, entity_id, observed_at desc);
create index if not exists prospect_source_entity_idx on public.prospect_source_records(entity_id, observed_at desc);
create index if not exists prospecting_events_run_idx on public.prospecting_events(run_id, created_at);
create unique index if not exists prospecting_events_external_id_unique on public.prospecting_events(run_id, external_event_id) where external_event_id is not null;
create unique index if not exists company_locations_source_unique on public.company_locations(company_id, source_prospect_location_id) where source_prospect_location_id is not null;
create unique index if not exists company_locations_prospect_location_unique
  on public.company_locations(source_prospect_location_id)
  where source_prospect_location_id is not null;
create index if not exists company_locations_company_idx on public.company_locations(company_id, is_primary desc);
create unique index if not exists company_locations_one_primary on public.company_locations(company_id) where is_primary;
create index if not exists prospecting_idempotency_expiry_idx on public.prospecting_api_idempotency(expires_at);
create index if not exists prospecting_retention_audits_date_idx on public.prospecting_retention_audits(purged_at desc);

drop trigger if exists set_prospecting_campaigns_updated_at on public.prospecting_campaigns;
create trigger set_prospecting_campaigns_updated_at before update on public.prospecting_campaigns
for each row execute function public.set_updated_at();
drop trigger if exists set_prospecting_runs_updated_at on public.prospecting_runs;
create trigger set_prospecting_runs_updated_at before update on public.prospecting_runs
for each row execute function public.set_updated_at();
drop trigger if exists set_prospecting_tasks_updated_at on public.prospecting_tasks;
create trigger set_prospecting_tasks_updated_at before update on public.prospecting_tasks
for each row execute function public.set_updated_at();
drop trigger if exists set_prospect_entities_updated_at on public.prospect_entities;
create trigger set_prospect_entities_updated_at before update on public.prospect_entities
for each row execute function public.set_updated_at();
drop trigger if exists set_prospect_locations_updated_at on public.prospect_locations;
create trigger set_prospect_locations_updated_at before update on public.prospect_locations
for each row execute function public.set_updated_at();
drop trigger if exists set_company_locations_updated_at on public.company_locations;
create trigger set_company_locations_updated_at before update on public.company_locations
for each row execute function public.set_updated_at();

create or replace function public.bump_prospecting_campaign_version()
returns trigger
language plpgsql
as $$
begin
  if row(new.name, new.description, new.sector, new.keywords, new.sources,
         new.region_codes, new.comuna_codes, new.target_types,
         new.result_limit_per_query, new.candidate_limit)
     is distinct from
     row(old.name, old.description, old.sector, old.keywords, old.sources,
         old.region_codes, old.comuna_codes, old.target_types,
         old.result_limit_per_query, old.candidate_limit) then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists bump_prospecting_campaign_version on public.prospecting_campaigns;
create trigger bump_prospecting_campaign_version
before update on public.prospecting_campaigns
for each row execute function public.bump_prospecting_campaign_version();

-- ---------------------------------------------------------------------------
-- Normalizacion, autorizacion e idempotencia
-- ---------------------------------------------------------------------------

create or replace function public.normalize_prospect_text(p_value text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(
    regexp_replace(
      translate(lower(trim(coalesce(p_value, ''))),
        'áéíóúüñàèìòùäëïöüç',
        'aeiouunaeiouaeiouc'),
      '[^a-z0-9]+', '', 'g'
    ),
    ''
  )
$$;

create or replace function public.normalize_prospect_name(p_value text)
returns text
language sql
immutable
parallel safe
as $$
  with cleaned as (
    select trim(regexp_replace(
      translate(upper(coalesce(p_value, '')),
        'ÁÉÍÓÚÜÑÀÈÌÒÙÄËÏÖÜÇ',
        'AEIOUUNAEIOUAEIOUC'),
      '[^A-Z0-9 ]+', ' ', 'g'
    )) as value
  ), without_legal_form as (
    select regexp_replace(
      value,
      '(^| )(SOCIEDAD POR ACCIONES|SOCIEDAD ANONIMA|SOCIEDAD DE RESPONSABILIDAD LIMITADA|EMPRESA INDIVIDUAL DE RESPONSABILIDAD LIMITADA|LIMITADA|E I R L|S P A|L T D A|S A|EIRL|LTDA|SPA|SA)( |$)',
      ' ',
      'i'
    ) as value
    from cleaned
  )
  select nullif(trim(regexp_replace(value, '[[:space:]]+', ' ', 'g')), '')
  from without_legal_form
$$;

create or replace function public.normalize_prospect_address(p_value text)
returns text
language sql
immutable
parallel safe
as $$
  with cleaned as (
    select ' ' || trim(regexp_replace(
      translate(upper(coalesce(p_value, '')),
        'ÁÉÍÓÚÜÑÀÈÌÒÙÄËÏÖÜÇ',
        'AEIOUUNAEIOUAEIOUC'),
      '[^A-Z0-9 ]+', ' ', 'g'
    )) || ' ' as value
  ), abbreviations as (
    select regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(value, ' (AVDA|AVENIDA) ', ' AV ', 'g'),
          ' (PSJE|PASAJE) ', ' PJE ', 'g'
        ),
        ' (DEPTO|DEPARTAMENTO) ', ' DPTO ', 'g'
      ),
      '[[:space:]]+', ' ', 'g'
    ) as value
    from cleaned
  )
  select nullif(trim(value), '') from abbreviations
$$;

create or replace function public.prospecting_valid_observed_at(p_value text)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_observed_at timestamptz;
begin
  v_observed_at := p_value::timestamptz;
  return isfinite(v_observed_at)
     and v_observed_at >= now() - interval '10 years'
     and v_observed_at <= now() + interval '5 minutes';
exception when others then
  return false;
end;
$$;

create or replace function public.normalize_prospect_phone(p_value text)
returns text
language sql
immutable
parallel safe
as $$
  with raw as (
    select regexp_replace(coalesce(p_value, ''), '[^0-9]+', '', 'g') as digits
  ), international as (
    select case when digits like '00%' then substr(digits, 3) else digits end as digits
    from raw
  ), national as (
    select case
      when length(digits) = 11 and left(digits, 2) = '56' then substr(digits, 3)
      when length(digits) = 9 then digits
      else null
    end as digits
    from international
  )
  select case when digits ~ '^[2-9][0-9]{8}$' then '+56' || digits else null end
  from national
$$;

create or replace function public.normalize_prospect_rut(p_value text)
returns text
language plpgsql
immutable
parallel safe
as $$
declare
  v_clean text := upper(regexp_replace(coalesce(p_value, ''), '[^0-9kK]+', '', 'g'));
  v_number text;
  v_given text;
  v_total integer := 0;
  v_multiplier integer := 2;
  v_remainder integer;
  v_expected text;
  i integer;
begin
  if length(v_clean) < 2 then return null; end if;
  v_number := left(v_clean, -1);
  v_given := right(v_clean, 1);
  if v_number !~ '^[0-9]+$' or v_number::numeric <= 0 then return null; end if;
  for i in reverse length(v_number)..1 loop
    v_total := v_total + substr(v_number, i, 1)::integer * v_multiplier;
    v_multiplier := case when v_multiplier < 7 then v_multiplier + 1 else 2 end;
  end loop;
  v_remainder := 11 - (v_total % 11);
  v_expected := case v_remainder when 11 then '0' when 10 then 'K' else v_remainder::text end;
  if v_expected <> v_given then return null; end if;
  return (v_number::numeric)::text || '-' || v_given;
end
$$;

create or replace function public.normalize_prospect_domain(p_value text)
returns text
language plpgsql
immutable
parallel safe
as $$
declare
  v_host text := lower(trim(coalesce(p_value, '')));
  v_labels text[];
  v_count integer;
  v_suffix2 text;
begin
  if v_host = '' then return null; end if;
  v_host := regexp_replace(v_host, '^[a-z][a-z0-9+.-]*://', '', 'i');
  v_host := regexp_replace(v_host, '^//', '');
  v_host := split_part(v_host, '/', 1);
  v_host := split_part(v_host, '?', 1);
  v_host := split_part(v_host, '#', 1);
  v_host := regexp_replace(v_host, '^.*@', '');
  v_host := regexp_replace(v_host, ':[0-9]+$', '');
  v_host := trim(both '.' from v_host);
  if v_host !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then return null; end if;
  v_labels := string_to_array(v_host, '.');
  v_count := cardinality(v_labels);
  if v_count < 2 or v_labels[v_count] !~ '^[a-z]{2,24}$' then return null; end if;
  v_suffix2 := v_labels[v_count - 1] || '.' || v_labels[v_count];
  if v_count >= 3 and v_suffix2 = any(array[
    'co.uk','org.uk','ac.uk','gov.uk','com.au','net.au','org.au',
    'com.br','com.ar','com.mx','co.nz','co.jp','co.kr','co.za','com.cn',
    'co.cl','gob.cl','gov.cl','mil.cl'
  ]) then
    return v_labels[v_count - 2] || '.' || v_suffix2;
  end if;
  return v_suffix2;
end
$$;

-- Re-ejecutar la migracion converge tambien si ya habia candidatos creados
-- con los normalizadores iniciales. Si la regla mas estricta revela dos
-- entidades antes separadas, conserva la identidad exacta en la mas antigua
-- y deja la otra para revision humana, sin violar los indices unicos.
drop index if exists public.prospect_entities_rut_unique;
drop index if exists public.prospect_entities_domain_unique;
drop index if exists public.prospect_entities_phone_unique;

with normalized as (
  select id,
         public.normalize_prospect_rut(rut) new_rut,
         public.normalize_prospect_domain(website) new_domain,
         public.normalize_prospect_phone(phone) new_phone,
         row_number() over (
           partition by public.normalize_prospect_rut(rut)
           order by created_at, id
         ) rut_rank,
         row_number() over (
           partition by public.normalize_prospect_domain(website)
           order by created_at, id
         ) domain_rank,
         row_number() over (
           partition by public.normalize_prospect_phone(phone)
           order by created_at, id
         ) phone_rank
  from public.prospect_entities
)
update public.prospect_entities e
set name_normalized = public.normalize_prospect_name(e.name),
    rut_normalized = case when n.new_rut is null or n.rut_rank = 1 then n.new_rut else null end,
    domain_normalized = case when n.new_domain is null or n.domain_rank = 1 then n.new_domain else null end,
    phone_normalized = case when n.new_phone is null or n.phone_rank = 1 then n.new_phone else null end,
    updated_at = now()
from normalized n
where n.id = e.id;

update public.prospect_locations
set address_normalized = public.normalize_prospect_address(address),
    updated_at = now();

create unique index prospect_entities_rut_unique
  on public.prospect_entities(rut_normalized) where rut_normalized is not null;
create unique index prospect_entities_domain_unique
  on public.prospect_entities(domain_normalized) where domain_normalized is not null;
create unique index prospect_entities_phone_unique
  on public.prospect_entities(phone_normalized) where phone_normalized is not null;

-- Backfill conservador de la geografia historica. Solo aplica cuando city
-- (y region, si existe) resuelven a una unica comuna; nunca reemplaza textos.
with geographic_matches as (
  select company_id, min(comuna_code) comuna_code, min(region_code) region_code
  from (
    select co.id company_id, gc.code comuna_code, gc.region_code
    from public.companies co
    join public.geo_comunas gc on exists (
      select 1 from unnest(array[gc.name] || gc.aliases) candidate_name
      where public.normalize_prospect_text(candidate_name) = public.normalize_prospect_text(co.city)
    )
    join public.geo_regions gr on gr.code = gc.region_code
    where co.city is not null
      and (
        co.region is null
        or exists (
          select 1 from unnest(array[gr.name] || gr.aliases) candidate_region
          where public.normalize_prospect_text(candidate_region) = public.normalize_prospect_text(co.region)
        )
      )
  ) resolved
  group by company_id
  having count(distinct comuna_code) = 1
)
update public.companies co
set comuna_code = coalesce(co.comuna_code, m.comuna_code),
    region_code = coalesce(co.region_code, m.region_code)
from geographic_matches m
where co.id = m.company_id
  and (co.comuna_code is null or co.region_code is null);

insert into public.company_locations (
  company_id, kind, region_code, comuna_code, address, phone, email, is_primary
)
select co.id, 'headquarters', co.region_code, co.comuna_code,
       co.address, co.phone, co.email, true
from public.companies co
where co.comuna_code is not null
  and not exists (
    select 1 from public.company_locations cl where cl.company_id = co.id
  );

create or replace function public.prospecting_require_roles(p_roles text[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return;
  end if;

  if coalesce(public.current_role()::text, '') <> all(p_roles) then
    raise exception using errcode = '42501', message = 'Insufficient prospecting permission';
  end if;
end;
$$;

create or replace function public.prospecting_begin_idempotent_request(
  p_api_key_id uuid,
  p_operation text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.prospecting_api_idempotency%rowtype;
  v_inserted integer := 0;
begin
  if p_api_key_id is null or length(trim(coalesce(p_operation, ''))) = 0
     or length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 200
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid idempotency parameters';
  end if;

  delete from public.prospecting_api_idempotency where expires_at < now();

  insert into public.prospecting_api_idempotency (
    api_key_id, operation, idempotency_key, request_hash
  ) values (
    p_api_key_id, trim(p_operation), trim(p_idempotency_key), p_request_hash
  ) on conflict do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    return jsonb_build_object('outcome', 'acquired');
  end if;

  select * into v_row
  from public.prospecting_api_idempotency
  where api_key_id = p_api_key_id
    and operation = trim(p_operation)
    and idempotency_key = trim(p_idempotency_key)
  for update;

  if v_row.request_hash <> p_request_hash then
    return jsonb_build_object('outcome', 'conflict');
  end if;

  if v_row.state = 'completed' then
    return jsonb_build_object(
      'outcome', 'replay',
      'response_status', v_row.response_status,
      'response_body', v_row.response_body
    );
  end if;

  if v_row.started_at < now() - interval '5 minutes' then
    update public.prospecting_api_idempotency
    set started_at = now(), expires_at = now() + interval '7 days'
    where api_key_id = p_api_key_id
      and operation = trim(p_operation)
      and idempotency_key = trim(p_idempotency_key);
    return jsonb_build_object('outcome', 'acquired');
  end if;

  return jsonb_build_object('outcome', 'in_progress');
end;
$$;

create or replace function public.prospecting_finish_idempotent_request(
  p_api_key_id uuid,
  p_operation text,
  p_idempotency_key text,
  p_request_hash text,
  p_response_status integer,
  p_response_body jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.prospecting_api_idempotency
  set state = 'completed',
      response_status = p_response_status,
      response_body = coalesce(p_response_body, '{}'::jsonb),
      completed_at = now(),
      expires_at = now() + interval '7 days'
  where api_key_id = p_api_key_id
    and operation = trim(p_operation)
    and idempotency_key = trim(p_idempotency_key)
    and request_hash = p_request_hash
    and state = 'processing';

  if not found then
    raise exception using errcode = 'P0001', message = 'Idempotency reservation not found';
  end if;
end;
$$;

create or replace function public.prospecting_release_idempotent_request(
  p_api_key_id uuid,
  p_operation text,
  p_idempotency_key text,
  p_request_hash text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.prospecting_api_idempotency
  where api_key_id = p_api_key_id
    and operation = trim(p_operation)
    and idempotency_key = trim(p_idempotency_key)
    and request_hash = p_request_hash
    and state = 'processing'
$$;

create or replace function public.prospecting_purge_expired_source_records_internal()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid := gen_random_uuid();
  v_summary record;
  v_total integer := 0;
  v_candidates_deleted integer := 0;
  v_entities_deleted integer := 0;
  v_locations_deleted integer := 0;
begin
  create temporary table if not exists prospecting_expired_pairs_tmp (
    run_id uuid,
    entity_id uuid,
    primary key (run_id, entity_id)
  ) on commit drop;
  truncate pg_temp.prospecting_expired_pairs_tmp;

  insert into pg_temp.prospecting_expired_pairs_tmp(run_id, entity_id)
  select distinct run_id, entity_id
  from public.prospect_source_records
  where retention_until is not null and retention_until <= now()
    and run_id is not null;

  for v_summary in
    with deleted as (
      delete from public.prospect_source_records
      where retention_until is not null and retention_until <= now()
      returning provider, observed_at
    )
    select provider, count(*)::integer records_deleted,
           min(observed_at) oldest_observed_at,
           max(observed_at) newest_observed_at
    from deleted
    group by provider
  loop
    insert into public.prospecting_retention_audits (
      batch_id, provider, records_deleted, oldest_observed_at, newest_observed_at
    ) values (
      v_batch_id, v_summary.provider, v_summary.records_deleted,
      v_summary.oldest_observed_at, v_summary.newest_observed_at
    );
    v_total := v_total + v_summary.records_deleted;
  end loop;

  -- El snapshot se conserva solo si este mismo run aun tiene nombre, contacto
  -- y al menos una sede respaldados por una fuente permanente. La evidencia de
  -- otro run nunca puede mantener vivo ni reconstruir este candidato.
  delete from public.prospecting_campaign_candidates candidate
  using pg_temp.prospecting_expired_pairs_tmp expired
  where candidate.run_id = expired.run_id
    and candidate.entity_id = expired.entity_id
    and not (
      exists (
        select 1 from public.prospect_source_records evidence
        where evidence.run_id = candidate.run_id
          and evidence.entity_id = candidate.entity_id
          and evidence.provider in ('brave_search','official_website')
          and evidence.field_name = 'name'
          and public.normalize_prospect_name(evidence.field_value)
              = public.normalize_prospect_name(candidate.candidate_snapshot->>'name')
          and (evidence.retention_until is null or evidence.retention_until > now())
      )
      and exists (
        select 1 from public.prospect_source_records evidence
        where evidence.run_id = candidate.run_id
          and evidence.entity_id = candidate.entity_id
          and evidence.provider in ('brave_search','official_website')
          and (evidence.retention_until is null or evidence.retention_until > now())
          and (
            (evidence.field_name = 'phone'
             and public.normalize_prospect_phone(evidence.field_value)
                 = public.normalize_prospect_phone(candidate.candidate_snapshot->>'phone'))
            or (evidence.field_name = 'email'
                and lower(trim(evidence.field_value)) = lower(trim(candidate.candidate_snapshot->>'email')))
            or (evidence.field_name = 'website'
                and public.normalize_prospect_domain(evidence.field_value)
                    = public.normalize_prospect_domain(candidate.candidate_snapshot->>'website'))
          )
      )
      and exists (
        select 1
        from jsonb_array_elements(
          case
            when jsonb_typeof(candidate.candidate_snapshot->'locations') = 'array'
              then candidate.candidate_snapshot->'locations'
            when jsonb_typeof(candidate.candidate_snapshot->'location') = 'object'
              then jsonb_build_array(candidate.candidate_snapshot->'location')
            else '[]'::jsonb
          end
        ) snapshot_location
        join public.prospect_locations location
          on location.entity_id = candidate.entity_id
         and location.region_code = snapshot_location->>'region_code'
         and location.comuna_code = snapshot_location->>'comuna_code'
         and coalesce(location.address_normalized, '') = coalesce(
               public.normalize_prospect_address(snapshot_location->>'address'), ''
             )
        where exists (
          select 1 from public.prospect_source_records evidence
          where evidence.run_id = candidate.run_id
            and evidence.entity_id = candidate.entity_id
            and evidence.location_id = location.id
            and evidence.provider in ('brave_search','official_website')
            and (
              (evidence.field_name ~ 'comuna_code$'
               and trim(evidence.field_value) = location.comuna_code)
              or (evidence.field_name ~ 'comuna_name$' and exists (
                select 1 from public.geo_comunas comuna
                where comuna.code = location.comuna_code
                  and public.normalize_prospect_text(evidence.field_value)
                      = public.normalize_prospect_text(comuna.name)
              ))
            )
            and (evidence.retention_until is null or evidence.retention_until > now())
        )
        and (
          (select count(*) from jsonb_array_elements(
             case when jsonb_typeof(candidate.candidate_snapshot->'locations') = 'array'
                  then candidate.candidate_snapshot->'locations'
                  else jsonb_build_array(candidate.candidate_snapshot->'location') end
           ) same_comuna
           where same_comuna->>'comuna_code' = snapshot_location->>'comuna_code') <= 1
          or (
            nullif(trim(snapshot_location->>'address'), '') is not null
            and exists (
              select 1 from public.prospect_source_records address_evidence
              where address_evidence.run_id = candidate.run_id
                and address_evidence.entity_id = candidate.entity_id
                and address_evidence.location_id = location.id
                and address_evidence.provider in ('brave_search','official_website')
                and address_evidence.field_name ~ '(^|\.)address$'
                and public.normalize_prospect_address(address_evidence.field_value)
                    = public.normalize_prospect_address(snapshot_location->>'address')
                and (address_evidence.retention_until is null or address_evidence.retention_until > now())
            )
          )
        )
      )
    );
  get diagnostics v_candidates_deleted = row_count;

  -- El vencimiento de un run antiguo no puede borrar una observacion Google
  -- mas reciente de la misma entidad. A la vez, un email oficial aislado no
  -- permite conservar nombre o geografia cuyo respaldo ya vencio.
  delete from public.prospect_entities entity
  where entity.id in (select entity_id from pg_temp.prospecting_expired_pairs_tmp)
    and not (
      exists (
        select 1 from public.prospect_source_records evidence
        where evidence.entity_id = entity.id and evidence.field_name = 'name'
          and (evidence.retention_until is null or evidence.retention_until > now())
      )
      and exists (
        select 1 from public.prospect_source_records evidence
        where evidence.entity_id = entity.id
          and (evidence.field_name ~ 'comuna_code$' or evidence.field_name ~ 'comuna_name$')
          and (evidence.retention_until is null or evidence.retention_until > now())
      )
      and exists (
        select 1 from public.prospect_source_records evidence
        where evidence.entity_id = entity.id and evidence.field_name in ('phone','email','website')
          and (evidence.retention_until is null or evidence.retention_until > now())
      )
    );
  get diagnostics v_entities_deleted = row_count;

  -- En entidades mixtas, elimina sedes sin evidencia vigente y rehidrata
  -- campos desde la observacion activa mas reciente. La aprobacion sigue
  -- exigiendo por separado una fuente almacenable.
  delete from public.prospect_locations location
  where location.entity_id in (select entity_id from pg_temp.prospecting_expired_pairs_tmp)
    and not exists (
      select 1 from public.prospect_source_records evidence
      where evidence.location_id = location.id
        and (
          (evidence.field_name ~ 'comuna_code$' and trim(evidence.field_value) = location.comuna_code)
          or (evidence.field_name ~ 'comuna_name$' and exists (
            select 1 from public.geo_comunas comuna
            where comuna.code = location.comuna_code
              and public.normalize_prospect_text(evidence.field_value) = public.normalize_prospect_text(comuna.name)
          ))
        )
        and (evidence.retention_until is null or evidence.retention_until > now())
    );
  get diagnostics v_locations_deleted = row_count;

  update public.prospect_entities entity
  set name = (
        select evidence.field_value from public.prospect_source_records evidence
        where evidence.entity_id = entity.id and evidence.field_name = 'name'
          and (evidence.retention_until is null or evidence.retention_until > now())
        order by evidence.observed_at desc, evidence.id desc limit 1
      ),
      name_normalized = public.normalize_prospect_name((
        select evidence.field_value from public.prospect_source_records evidence
        where evidence.entity_id = entity.id and evidence.field_name = 'name'
          and (evidence.retention_until is null or evidence.retention_until > now())
        order by evidence.observed_at desc, evidence.id desc limit 1
      )),
      legal_name = (select evidence.field_value from public.prospect_source_records evidence
        where evidence.entity_id = entity.id and evidence.field_name = 'trade_name'
          and (evidence.retention_until is null or evidence.retention_until > now())
        order by evidence.observed_at desc, evidence.id desc limit 1),
      rut = (select evidence.field_value from public.prospect_source_records evidence
        where evidence.entity_id = entity.id and evidence.field_name = 'rut'
          and (evidence.retention_until is null or evidence.retention_until > now())
        order by evidence.observed_at desc, evidence.id desc limit 1),
      phone = (select evidence.field_value from public.prospect_source_records evidence
        where evidence.entity_id = entity.id and evidence.field_name = 'phone'
          and (evidence.retention_until is null or evidence.retention_until > now())
        order by evidence.observed_at desc, evidence.id desc limit 1),
      email = lower((select evidence.field_value from public.prospect_source_records evidence
        where evidence.entity_id = entity.id and evidence.field_name = 'email'
          and (evidence.retention_until is null or evidence.retention_until > now())
        order by evidence.observed_at desc, evidence.id desc limit 1)),
      website = (select evidence.field_value from public.prospect_source_records evidence
        where evidence.entity_id = entity.id and evidence.field_name = 'website'
          and (evidence.retention_until is null or evidence.retention_until > now())
        order by evidence.observed_at desc, evidence.id desc limit 1),
      description = (select evidence.field_value from public.prospect_source_records evidence
        where evidence.entity_id = entity.id and evidence.field_name = 'description'
          and (evidence.retention_until is null or evidence.retention_until > now())
        order by evidence.observed_at desc, evidence.id desc limit 1),
      updated_at = now()
  where entity.id in (select entity_id from pg_temp.prospecting_expired_pairs_tmp);

  update public.prospect_entities
  set rut_normalized = public.normalize_prospect_rut(rut),
      phone_normalized = public.normalize_prospect_phone(phone),
      domain_normalized = public.normalize_prospect_domain(website)
  where id in (select entity_id from pg_temp.prospecting_expired_pairs_tmp);

  update public.prospect_locations location
  set address = (select evidence.field_value from public.prospect_source_records evidence
        where evidence.location_id = location.id and evidence.field_name ~ '\.address$|^address$|^location\.address$'
          and (evidence.retention_until is null or evidence.retention_until > now())
        order by evidence.observed_at desc, evidence.id desc limit 1),
      latitude = null,
      longitude = null,
      phone = (select evidence.field_value from public.prospect_source_records evidence
        where evidence.location_id = location.id and evidence.field_name ~ '\.phone$|^phone$'
          and (evidence.retention_until is null or evidence.retention_until > now())
        order by evidence.observed_at desc, evidence.id desc limit 1),
      email = lower((select evidence.field_value from public.prospect_source_records evidence
        where evidence.location_id = location.id and evidence.field_name ~ '\.email$|^email$'
          and (evidence.retention_until is null or evidence.retention_until > now())
        order by evidence.observed_at desc, evidence.id desc limit 1)),
      updated_at = now()
  where location.entity_id in (select entity_id from pg_temp.prospecting_expired_pairs_tmp);

  update public.prospect_locations
  set address_normalized = public.normalize_prospect_address(address)
  where entity_id in (select entity_id from pg_temp.prospecting_expired_pairs_tmp);

  with candidate_scope as (
    select candidate.id candidate_id, candidate.run_id, candidate.entity_id,
           candidate.candidate_snapshot,
           case
             when jsonb_typeof(candidate.candidate_snapshot->'locations') = 'array'
               then candidate.candidate_snapshot->'locations'
             when jsonb_typeof(candidate.candidate_snapshot->'location') = 'object'
               then jsonb_build_array(candidate.candidate_snapshot->'location')
             else '[]'::jsonb
           end snapshot_locations
    from public.prospecting_campaign_candidates candidate
    join pg_temp.prospecting_expired_pairs_tmp expired
      on expired.run_id = candidate.run_id and expired.entity_id = candidate.entity_id
  ), permanent_locations as (
    select scope.candidate_id, snapshot_location.ordinality original_position,
           jsonb_strip_nulls(jsonb_build_object(
             'country_code', coalesce(snapshot_location.item->>'country_code', 'CL'),
             'region_code', location.region_code,
             'region_name', region.name,
             'comuna_code', location.comuna_code,
             'comuna_name', comuna.name,
             'address', case when exists (
               select 1 from public.prospect_source_records evidence
               where evidence.run_id = scope.run_id
                 and evidence.entity_id = scope.entity_id
                 and evidence.location_id = location.id
                 and evidence.provider in ('brave_search','official_website')
                 and evidence.field_name ~ '(^|\.)address$'
                 and public.normalize_prospect_address(evidence.field_value)
                     = public.normalize_prospect_address(snapshot_location.item->>'address')
                 and (evidence.retention_until is null or evidence.retention_until > now())
             ) then snapshot_location.item->>'address' else null end,
             'kind', snapshot_location.item->>'kind',
             'is_primary', snapshot_location.item->'is_primary'
           )) rebuilt_location
    from candidate_scope scope
    cross join lateral jsonb_array_elements(scope.snapshot_locations)
      with ordinality snapshot_location(item, ordinality)
    join public.prospect_locations location
      on location.entity_id = scope.entity_id
     and location.region_code = snapshot_location.item->>'region_code'
     and location.comuna_code = snapshot_location.item->>'comuna_code'
     and coalesce(location.address_normalized, '') = coalesce(
           public.normalize_prospect_address(snapshot_location.item->>'address'), ''
         )
    join public.geo_comunas comuna on comuna.code = location.comuna_code
    join public.geo_regions region on region.code = location.region_code
    where exists (
      select 1 from public.prospect_source_records evidence
      where evidence.run_id = scope.run_id
        and evidence.entity_id = scope.entity_id
        and evidence.location_id = location.id
        and evidence.provider in ('brave_search','official_website')
        and (
          (evidence.field_name ~ 'comuna_code$' and trim(evidence.field_value) = location.comuna_code)
          or (evidence.field_name ~ 'comuna_name$'
              and public.normalize_prospect_text(evidence.field_value)
                  = public.normalize_prospect_text(comuna.name))
        )
        and (evidence.retention_until is null or evidence.retention_until > now())
    )
      and (
        (select count(*) from jsonb_array_elements(scope.snapshot_locations) same_comuna
         where same_comuna->>'comuna_code' = snapshot_location.item->>'comuna_code') <= 1
        or (
          nullif(trim(snapshot_location.item->>'address'), '') is not null
          and exists (
            select 1 from public.prospect_source_records evidence
            where evidence.run_id = scope.run_id
              and evidence.entity_id = scope.entity_id
              and evidence.location_id = location.id
              and evidence.provider in ('brave_search','official_website')
              and evidence.field_name ~ '(^|\.)address$'
              and public.normalize_prospect_address(evidence.field_value)
                  = public.normalize_prospect_address(snapshot_location.item->>'address')
              and (evidence.retention_until is null or evidence.retention_until > now())
          )
        )
      )
  ), ranked_locations as (
    select permanent_locations.*,
           (row_number() over (
             partition by candidate_id order by original_position
           ) - 1)::integer new_index
    from permanent_locations
  ), location_sets as (
    select candidate_id,
           (array_agg(rebuilt_location order by original_position))[1] primary_location,
           jsonb_agg(rebuilt_location order by original_position) locations,
           jsonb_agg(new_index order by original_position) importable_indexes
    from ranked_locations
    group by candidate_id
  ), rebuilt as (
    select scope.candidate_id,
           jsonb_strip_nulls(jsonb_build_object(
             'name', case when exists (
               select 1 from public.prospect_source_records evidence
               where evidence.run_id = scope.run_id and evidence.entity_id = scope.entity_id
                 and evidence.provider in ('brave_search','official_website')
                 and evidence.field_name = 'name'
                 and public.normalize_prospect_name(evidence.field_value)
                     = public.normalize_prospect_name(scope.candidate_snapshot->>'name')
                 and (evidence.retention_until is null or evidence.retention_until > now())
             ) then scope.candidate_snapshot->>'name' end,
             'trade_name', case when exists (
               select 1 from public.prospect_source_records evidence
               where evidence.run_id = scope.run_id and evidence.entity_id = scope.entity_id
                 and evidence.provider in ('brave_search','official_website')
                 and evidence.field_name = 'trade_name'
                 and public.normalize_prospect_text(evidence.field_value)
                     = public.normalize_prospect_text(scope.candidate_snapshot->>'trade_name')
             ) then scope.candidate_snapshot->>'trade_name' end,
             'rut', case when exists (
               select 1 from public.prospect_source_records evidence
               where evidence.run_id = scope.run_id and evidence.entity_id = scope.entity_id
                 and evidence.provider in ('brave_search','official_website')
                 and evidence.field_name = 'rut'
                 and public.normalize_prospect_rut(evidence.field_value)
                     = public.normalize_prospect_rut(scope.candidate_snapshot->>'rut')
             ) then scope.candidate_snapshot->>'rut' end,
             'phone', case when exists (
               select 1 from public.prospect_source_records evidence
               where evidence.run_id = scope.run_id and evidence.entity_id = scope.entity_id
                 and evidence.provider in ('brave_search','official_website')
                 and evidence.field_name = 'phone'
                 and public.normalize_prospect_phone(evidence.field_value)
                     = public.normalize_prospect_phone(scope.candidate_snapshot->>'phone')
             ) then scope.candidate_snapshot->>'phone' end,
             'email', case when exists (
               select 1 from public.prospect_source_records evidence
               where evidence.run_id = scope.run_id and evidence.entity_id = scope.entity_id
                 and evidence.provider in ('brave_search','official_website')
                 and evidence.field_name = 'email'
                 and lower(trim(evidence.field_value)) = lower(trim(scope.candidate_snapshot->>'email'))
             ) then lower(trim(scope.candidate_snapshot->>'email')) end,
             'website', case when exists (
               select 1 from public.prospect_source_records evidence
               where evidence.run_id = scope.run_id and evidence.entity_id = scope.entity_id
                 and evidence.provider in ('brave_search','official_website')
                 and evidence.field_name = 'website'
                 and public.normalize_prospect_domain(evidence.field_value)
                     = public.normalize_prospect_domain(scope.candidate_snapshot->>'website')
             ) then scope.candidate_snapshot->>'website' end,
             'description', case when exists (
               select 1 from public.prospect_source_records evidence
               where evidence.run_id = scope.run_id and evidence.entity_id = scope.entity_id
                 and evidence.provider in ('brave_search','official_website')
                 and evidence.field_name = 'description'
                 and public.normalize_prospect_text(evidence.field_value)
                     = public.normalize_prospect_text(scope.candidate_snapshot->>'description')
             ) then scope.candidate_snapshot->>'description' end
           )) fields,
           coalesce((
             select jsonb_object_agg(provider_record.provider, provider_record.provider_record_id)
             from (
               select distinct on (evidence.provider)
                      evidence.provider, evidence.provider_record_id
               from public.prospect_source_records evidence
               where evidence.run_id = scope.run_id and evidence.entity_id = scope.entity_id
                 and evidence.provider in ('brave_search','official_website')
                 and evidence.provider_record_id is not null
                 and (evidence.retention_until is null or evidence.retention_until > now())
               order by evidence.provider, evidence.observed_at desc, evidence.id desc
             ) provider_record
           ), '{}'::jsonb) provider_ids,
           coalesce((
             select jsonb_agg(flag)
             from jsonb_array_elements_text(
               case when jsonb_typeof(scope.candidate_snapshot->'review_flags') = 'array'
                    then scope.candidate_snapshot->'review_flags' else '[]'::jsonb end
             ) flag
             where flag like 'conflicting_exact%'
           ), '[]'::jsonb) review_flags
    from candidate_scope scope
  )
  update public.prospecting_campaign_candidates candidate
  set candidate_snapshot =
      (candidate.candidate_snapshot - 'name' - 'trade_name' - 'rut' - 'phone' - 'email'
       - 'website' - 'description' - 'provider_ids' - 'location' - 'locations'
       - 'import_eligible' - 'importable_location_indexes' - 'review_flags')
      || rebuilt.fields
      || jsonb_build_object(
           'provider_ids', rebuilt.provider_ids,
           'location', location_sets.primary_location,
           'locations', location_sets.locations,
           'import_eligible', true,
           'importable_location_indexes', location_sets.importable_indexes,
           'review_flags', rebuilt.review_flags
         )
  from rebuilt
  join location_sets on location_sets.candidate_id = rebuilt.candidate_id
  where candidate.id = rebuilt.candidate_id;

  update public.prospecting_runs run
  set candidates_found = (
    select count(*) from public.prospecting_campaign_candidates candidate where candidate.run_id = run.id
  )
  where run.id in (select run_id from pg_temp.prospecting_expired_pairs_tmp);

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'records_deleted', v_total,
    'candidate_snapshots_deleted', v_candidates_deleted,
    'entities_deleted', v_entities_deleted,
    'locations_deleted', v_locations_deleted,
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', provider,
        'records_deleted', records_deleted,
        'oldest_observed_at', oldest_observed_at,
        'newest_observed_at', newest_observed_at
      ) order by provider)
      from public.prospecting_retention_audits where batch_id = v_batch_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.prospecting_purge_expired_source_records_internal() from public;

create or replace function public.purge_expired_prospect_source_records()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.prospecting_require_roles(array['administrador']);
  return public.prospecting_purge_expired_source_records_internal();
end;
$$;

-- Programa la purga diaria cuando pg_cron esta disponible en el proyecto.
-- Es segura de re-ejecutar; en desarrollo local sin la extension no hace nada.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'prospecting-retention-daily') then
      perform cron.schedule(
        'prospecting-retention-daily',
        '17 3 * * *',
        'select public.prospecting_purge_expired_source_records_internal()'
      );
    end if;
  end if;
exception when undefined_table or insufficient_privilege then
  raise notice 'pg_cron no disponible; programe manualmente la purga antes de produccion';
end
$$;

-- ---------------------------------------------------------------------------
-- Ciclo de vida de campanas y ejecuciones
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_prospecting_run(
  p_campaign_id uuid,
  p_requested_by uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign public.prospecting_campaigns%rowtype;
  v_run_id uuid := gen_random_uuid();
  v_comuna_codes text[];
  v_territories jsonb;
  v_snapshot jsonb;
  v_task_count integer;
  v_requester uuid;
begin
  perform public.prospecting_require_roles(array['administrador']);

  if coalesce(auth.role(), '') = 'service_role' then
    v_requester := coalesce(p_requested_by, auth.uid());
  else
    if p_requested_by is not null and p_requested_by is distinct from auth.uid() then
      raise exception using errcode = '42501', message = 'requested_by must match the authenticated user';
    end if;
    v_requester := auth.uid();
  end if;
  if v_requester is null then
    raise exception using errcode = '22023', message = 'A requester is required';
  end if;

  select * into v_campaign
  from public.prospecting_campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Prospecting campaign not found';
  end if;
  if v_campaign.status = 'archived' then
    raise exception using errcode = '22023', message = 'Archived campaign cannot be enqueued';
  end if;
  if not public.prospecting_keywords_valid(v_campaign.keywords) then
    raise exception using errcode = '22023',
      message = 'Campaign keywords must contain 1 to 50 unique trimmed values of at most 200 characters';
  end if;
  if 'brave_search' = any(v_campaign.sources)
     and not ('official_website' = any(v_campaign.sources)) then
    raise exception using errcode = '22023',
      message = 'brave_search requires official_website to validate contact and territory';
  end if;

  select coalesce(array_agg(distinct c.code order by c.code), '{}')
  into v_comuna_codes
  from public.geo_comunas c
  where c.active
    and (
      (cardinality(v_campaign.comuna_codes) > 0 and c.code = any(v_campaign.comuna_codes))
      or
      (cardinality(v_campaign.comuna_codes) = 0 and c.region_code = any(v_campaign.region_codes))
    );

  if cardinality(v_comuna_codes) = 0 then
    raise exception using errcode = '22023', message = 'Campaign must include at least one valid region or comuna';
  end if;

  if exists (
    select 1 from unnest(v_campaign.comuna_codes) code
    where not exists (select 1 from public.geo_comunas c where c.code = code and c.active)
  ) or exists (
    select 1 from unnest(v_campaign.region_codes) code
    where not exists (select 1 from public.geo_regions r where r.code = code and r.active)
  ) then
    raise exception using errcode = '22023', message = 'Campaign contains an unknown geographic code';
  end if;

  v_task_count := cardinality(v_comuna_codes) * cardinality(v_campaign.keywords)
    * (select count(*) from unnest(v_campaign.sources) s where s in ('google_places','brave_search'));
  if v_task_count = 0 then
    raise exception using errcode = '22023', message = 'Campaign requires google_places or brave_search as discovery source';
  end if;
  if v_task_count > 10000 then
    raise exception using errcode = '54000', message = 'Campaign expands to more than 10000 tasks';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'country_code', 'CL',
    'region_code', r.code,
    'region_name', r.name,
    'comuna_code', c.code,
    'comuna_name', c.name
  ) order by r.sort_order, c.name), '[]'::jsonb)
  into v_territories
  from public.geo_comunas c
  join public.geo_regions r on r.code = c.region_code
  where c.code = any(v_comuna_codes);

  v_snapshot := jsonb_build_object(
    'schema_version', '1.0',
    'crm_run_id', v_run_id,
    'campaign_version', v_campaign.version,
    'campaign', jsonb_build_object(
      'crm_campaign_id', v_campaign.id,
      'name', v_campaign.name,
      'sector', v_campaign.sector,
      'territories', v_territories,
      'keywords', to_jsonb(v_campaign.keywords),
      'sources', to_jsonb(v_campaign.sources),
      'target_types', to_jsonb(v_campaign.target_types),
      'max_results_per_task', v_campaign.result_limit_per_query,
      'max_candidates', v_campaign.candidate_limit
    ),
    'territories', v_territories,
    'limits', jsonb_build_object(
      'results_per_query', v_campaign.result_limit_per_query,
      'candidate_limit', v_campaign.candidate_limit,
      'estimated_queries', v_task_count
    ),
    'requested_at', now(),
    'requested_by', v_requester::text
  );

  insert into public.prospecting_runs (
    id, campaign_id, status, snapshot, requested_by, total_tasks,
    progress
  ) values (
    v_run_id, v_campaign.id, 'pending', v_snapshot,
    v_requester, v_task_count,
    jsonb_build_object('percent', 0, 'completed_tasks', 0, 'failed_tasks', 0)
  );

  insert into public.prospecting_tasks (run_id, source, keyword, region_code, comuna_code)
  select v_run_id, source, keyword, c.region_code, c.code
  from unnest(v_campaign.sources) source
  cross join unnest(v_campaign.keywords) keyword
  cross join public.geo_comunas c
  where c.code = any(v_comuna_codes)
    and source in ('google_places','brave_search');

  update public.prospecting_campaigns
  set status = 'active', updated_by = v_requester
  where id = v_campaign.id;

  insert into public.prospecting_events (run_id, level, stage, message, metrics)
  values (v_run_id, 'info', 'queued', 'Prospecting run queued by CRM', jsonb_build_object('total_tasks', v_task_count));

  return jsonb_build_object(
    'id', v_run_id,
    'campaign_id', v_campaign.id,
    'status', 'pending',
    'total_tasks', v_task_count,
    'snapshot', v_snapshot
  );
end;
$$;

create or replace function public.claim_prospecting_run(
  p_api_key_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.prospecting_runs%rowtype;
  v_lease_token uuid := gen_random_uuid();
  v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 300);
  v_tasks jsonb;
begin
  if p_api_key_id is null or length(trim(coalesce(p_worker_id, ''))) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'api_key_id and worker_id are required';
  end if;

  -- Una cancelacion no queda atascada si el worker desaparecio antes de
  -- reconocerla. Al vencer su lease se cierra antes de asignar otro run.
  update public.prospecting_tasks t
  set status = 'cancelled', completed_at = coalesce(t.completed_at, now())
  where t.status in ('pending','running')
    and exists (
      select 1 from public.prospecting_runs r
      where r.id = t.run_id and r.status = 'cancel_requested'
        and (r.lease_expires_at is null or r.lease_expires_at < now())
    );

  with cancelled as (
    update public.prospecting_runs
    set status = 'cancelled', completed_at = now(), lease_token = null,
        lease_expires_at = null
    where status = 'cancel_requested'
      and (lease_expires_at is null or lease_expires_at < now())
    returning id
  )
  insert into public.prospecting_events (run_id, level, stage, message)
  select id, 'warning', 'cancelled', 'Cancellation completed after worker lease expired'
  from cancelled;

  -- Reintentar un claim del mismo worker devuelve el lease vigente en vez de
  -- asignarle otra ejecucion si la respuesta anterior se perdio.
  select * into v_run
  from public.prospecting_runs
  where status = 'running'
    and claimed_by_api_key = p_api_key_id
    and claimed_by_worker = trim(p_worker_id)
    and lease_expires_at >= now()
  order by started_at
  for update
  limit 1;

  if found then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]'::jsonb)
    into v_tasks
    from public.prospecting_tasks t
    where t.run_id = v_run.id;

    return jsonb_build_object(
      'run', to_jsonb(v_run) - 'lease_token',
      'lease_token', v_run.lease_token,
      'tasks', v_tasks
    );
  end if;

  select * into v_run
  from public.prospecting_runs
  where status = 'pending'
     or (status = 'running' and lease_expires_at < now())
  order by created_at
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('run', null);
  end if;

  -- Una tarea que perdio el lease conserva sus intentos. Si ya consumo el
  -- ultimo, se vuelve terminal; las demas pueden reintentarse. Nunca se deja
  -- una tarea pending pero inreclamable.
  update public.prospecting_tasks
  set status = 'failed', completed_at = coalesce(completed_at, now()),
      last_error = coalesce(last_error, 'Worker lease expired after final attempt')
  where run_id = v_run.id
    and status in ('pending','running')
    and attempts >= max_attempts;

  update public.prospecting_tasks
  set status = 'pending', started_at = null, completed_at = null
  where run_id = v_run.id and status = 'running' and attempts < max_attempts;

  update public.prospecting_runs
  set status = 'running',
      claimed_by_api_key = p_api_key_id,
      claimed_by_worker = trim(p_worker_id),
      lease_token = v_lease_token,
      lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      heartbeat_at = now(),
      claim_count = claim_count + 1,
      started_at = coalesce(started_at, now()),
      last_error = null
  where id = v_run.id
  returning * into v_run;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]'::jsonb)
  into v_tasks
  from public.prospecting_tasks t
  where t.run_id = v_run.id;

  insert into public.prospecting_events (run_id, level, stage, message, metrics)
  values (v_run.id, 'info', 'claimed', 'Run claimed by worker',
    jsonb_build_object('worker_id', trim(p_worker_id), 'lease_seconds', v_lease_seconds));

  return jsonb_build_object(
    'run', to_jsonb(v_run) - 'lease_token',
    'lease_token', v_lease_token,
    'tasks', v_tasks
  );
end;
$$;

create or replace function public.heartbeat_prospecting_run(
  p_run_id uuid,
  p_api_key_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.prospecting_runs%rowtype;
  v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 300);
begin
  select * into v_run from public.prospecting_runs where id = p_run_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Prospecting run not found';
  end if;

  if v_run.claimed_by_api_key is distinct from p_api_key_id
     or v_run.claimed_by_worker is distinct from trim(p_worker_id)
     or v_run.lease_token is distinct from p_lease_token then
    raise exception using errcode = '42501', message = 'Invalid run lease';
  end if;

  if v_run.status not in ('running','cancel_requested')
     or v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    raise exception using errcode = '55000', message = 'Run lease expired or run is not active';
  end if;

  update public.prospecting_runs
  set heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => v_lease_seconds)
  where id = p_run_id
  returning lease_expires_at into v_run.lease_expires_at;

  return jsonb_build_object(
    'status', v_run.status,
    'cancel_requested', v_run.status = 'cancel_requested',
    'lease_expires_at', v_run.lease_expires_at
  );
end;
$$;

create or replace function public.request_prospecting_run_cancel(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.prospecting_runs%rowtype;
begin
  perform public.prospecting_require_roles(array['administrador']);
  select * into v_run from public.prospecting_runs where id = p_run_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Prospecting run not found';
  end if;

  if v_run.status in ('partial','completed','failed','cancelled') then
    return jsonb_build_object('id', v_run.id, 'status', v_run.status);
  end if;

  if v_run.status = 'pending' or v_run.lease_expires_at is null or v_run.lease_expires_at < now() then
    update public.prospecting_tasks
    set status = 'cancelled', completed_at = coalesce(completed_at, now())
    where run_id = p_run_id and status in ('pending','running');
    update public.prospecting_runs
    set status = 'cancelled', cancel_requested_at = now(), completed_at = now(),
        lease_token = null, lease_expires_at = null
    where id = p_run_id;
    v_run.status := 'cancelled';
  else
    update public.prospecting_runs
    set status = 'cancel_requested', cancel_requested_at = now()
    where id = p_run_id;
    v_run.status := 'cancel_requested';
  end if;

  insert into public.prospecting_events (run_id, level, stage, message)
  values (p_run_id, 'warning', 'cancel_requested', 'Cancellation requested from CRM');

  return jsonb_build_object('id', v_run.id, 'status', v_run.status);
end;
$$;

create or replace function public.append_prospecting_events(
  p_run_id uuid,
  p_api_key_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.prospecting_runs%rowtype;
  v_event jsonb;
  v_task_id uuid;
  v_task_status text;
  v_count integer;
begin
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'events must contain between 1 and 100 items';
  end if;
  if octet_length(p_events::text) > 1000000 then
    raise exception using errcode = '22023', message = 'events payload exceeds 1000000 bytes';
  end if;

  select * into v_run from public.prospecting_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Prospecting run not found'; end if;
  if v_run.status not in ('running','cancel_requested')
     or v_run.lease_expires_at is null or v_run.lease_expires_at <= now()
     or v_run.claimed_by_api_key is distinct from p_api_key_id
     or v_run.claimed_by_worker is distinct from trim(p_worker_id)
     or v_run.lease_token is distinct from p_lease_token then
    raise exception using errcode = '42501', message = 'Invalid or expired run lease';
  end if;

  for v_event in select value from jsonb_array_elements(p_events)
  loop
    if jsonb_typeof(v_event) <> 'object'
       or length(trim(coalesce(v_event->>'stage',''))) = 0
       or length(trim(coalesce(v_event->>'stage',''))) > 80
       or length(trim(coalesce(v_event->>'message',''))) = 0
       or length(v_event->>'message') > 4000
       or length(coalesce(v_event->>'keyword','')) > 200
       or octet_length(coalesce((v_event->'metrics')::text, '{}')) > 20000 then
      raise exception using errcode = '22023', message = 'Each event requires stage and message';
    end if;

    v_task_id := nullif(v_event->>'task_id','')::uuid;
    if v_task_id is not null and not exists (
      select 1 from public.prospecting_tasks where id = v_task_id and run_id = p_run_id
    ) then
      raise exception using errcode = '22023', message = 'Event task does not belong to run';
    end if;

    insert into public.prospecting_events (
      external_event_id, run_id, task_id, level, stage, message, metrics, source, keyword, comuna_code, created_at
    ) values (
      nullif(left(trim(v_event->>'event_id'), 200), ''),
      p_run_id,
      v_task_id,
      case when v_event->>'level' in ('debug','info','warning','error') then v_event->>'level' else 'info' end,
      left(trim(v_event->>'stage'), 100),
      left(trim(v_event->>'message'), 2000),
      case when jsonb_typeof(v_event->'metrics') = 'object' then v_event->'metrics' else '{}'::jsonb end,
      nullif(left(trim(v_event->>'source'), 100), ''),
      nullif(left(trim(v_event->>'keyword'), 200), ''),
      nullif(v_event->>'comuna_code',''),
      coalesce(
        nullif(v_event->>'occurred_at','')::timestamptz,
        nullif(v_event->>'created_at','')::timestamptz,
        now()
      )
    ) on conflict (run_id, external_event_id) where external_event_id is not null do nothing;

    v_task_status := v_event->>'task_status';
    if v_task_id is not null and v_task_status in ('pending','running','completed','failed','cancelled') then
      update public.prospecting_tasks
      set status = v_task_status,
          attempts = case when v_task_status = 'running' and status <> 'running' then attempts + 1 else attempts end,
          results_found = coalesce((v_event->'metrics'->>'results_found')::integer, results_found),
          results_discarded = coalesce((v_event->'metrics'->>'results_discarded')::integer, results_discarded),
          last_error = case when v_task_status = 'failed' then left(coalesce(v_event->>'message',''), 2000) else last_error end,
          started_at = case when v_task_status = 'running' then coalesce(started_at, now()) else started_at end,
          completed_at = case when v_task_status in ('completed','failed','cancelled') then now() else null end
      where id = v_task_id and run_id = p_run_id;
    end if;
  end loop;

  select count(*) into v_count from jsonb_array_elements(p_events);
  update public.prospecting_runs r
  set completed_tasks = s.completed,
      failed_tasks = s.failed,
      progress = jsonb_build_object(
        'percent', case when r.total_tasks = 0 then 0 else round(((s.completed + s.failed)::numeric / r.total_tasks) * 100, 2) end,
        'completed_tasks', s.completed,
        'failed_tasks', s.failed
      )
  from (
    select count(*) filter (where status = 'completed')::integer completed,
           count(*) filter (where status = 'failed')::integer failed
    from public.prospecting_tasks where run_id = p_run_id
  ) s
  where r.id = p_run_id;

  return jsonb_build_object('accepted', v_count);
end;
$$;

create or replace function public.upsert_prospect_candidates(
  p_run_id uuid,
  p_api_key_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_candidates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.prospecting_runs%rowtype;
  v_candidate jsonb;
  v_locations jsonb;
  v_location jsonb;
  v_location_item jsonb;
  v_evidence jsonb;
  v_entity_id uuid;
  v_location_id uuid;
  v_primary_location_id uuid;
  v_candidate_row_id uuid;
  v_existing_candidate_row_id uuid;
  v_duplicate_company_id uuid;
  v_name text;
  v_name_normalized text;
  v_rut_normalized text;
  v_domain_normalized text;
  v_phone_normalized text;
  v_region_code text;
  v_comuna_code text;
  v_address_normalized text;
  v_provider_record_id text;
  v_evidence_location_id uuid;
  v_evidence_location_index integer;
  v_location_position integer;
  v_existing_run_entity_id uuid;
  v_exact_entity_ids uuid[];
  v_exact_company_ids uuid[];
  v_identity_conflict boolean;
  v_entity_hierarchy_conflict boolean;
  v_company_hierarchy_conflict boolean;
  v_entity_match_priority integer;
  v_company_match_priority integer;
  v_existing_run_is_quarantine boolean;
  v_review_status text;
  v_score numeric;
  v_limit integer;
  v_accepted integer := 0;
  v_rejected_limit integer := 0;
begin
  if jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'candidates must contain between 1 and 100 items';
  end if;
  if octet_length(p_candidates::text) > 1000000 then
    raise exception using errcode = '22023', message = 'candidates payload exceeds 1000000 bytes';
  end if;

  select * into v_run from public.prospecting_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Prospecting run not found'; end if;
  if v_run.status not in ('running','cancel_requested')
     or v_run.lease_expires_at is null or v_run.lease_expires_at <= now()
     or v_run.claimed_by_api_key is distinct from p_api_key_id
     or v_run.claimed_by_worker is distinct from trim(p_worker_id)
     or v_run.lease_token is distinct from p_lease_token then
    raise exception using errcode = '42501', message = 'Invalid or expired run lease';
  end if;

  v_limit := coalesce((v_run.snapshot #>> '{campaign,max_candidates}')::integer, 1000);

  for v_candidate in select value from jsonb_array_elements(p_candidates)
  loop
    if jsonb_typeof(v_candidate) <> 'object' then
      raise exception using errcode = '22023', message = 'Each candidate must be an object';
    end if;
    if octet_length(v_candidate::text) > 100000 then
      raise exception using errcode = '22023', message = 'Candidate payload exceeds 100000 bytes';
    end if;

    v_name := trim(coalesce(v_candidate->>'name', ''));
    if jsonb_typeof(v_candidate->'locations') = 'array'
       and jsonb_array_length(v_candidate->'locations') > 0 then
      v_locations := v_candidate->'locations';
    elsif jsonb_typeof(v_candidate->'location') = 'object' then
      v_locations := jsonb_build_array(v_candidate->'location');
    else
      raise exception using errcode = '22023', message = 'Each candidate requires location or locations';
    end if;
    if jsonb_array_length(v_locations) > 50 then
      raise exception using errcode = '22023', message = 'A candidate cannot contain more than 50 locations';
    end if;

    select item into v_location
    from jsonb_array_elements(v_locations) with ordinality locations(item, position)
    order by case when item->>'is_primary' = 'true' then 0 else 1 end, position
    limit 1;
    v_region_code := nullif(trim(v_location->>'region_code'), '');
    v_comuna_code := nullif(trim(v_location->>'comuna_code'), '');

    if length(v_name) = 0 or length(v_name) > 300
       or length(coalesce(v_candidate->>'candidate_id','')) > 200
       or length(coalesce(v_candidate->>'trade_name','')) > 300
       or length(coalesce(v_candidate->>'rut','')) > 32
       or length(coalesce(v_candidate->>'phone','')) > 50
       or length(coalesce(v_candidate->>'email','')) > 320
       or length(coalesce(v_candidate->>'website','')) > 2048
       or length(coalesce(v_candidate->>'category','')) > 120
       or length(coalesce(v_candidate->>'description','')) > 4000 then
      raise exception using errcode = '22023', message = 'Each candidate requires a valid name';
    end if;
    for v_location_item in select value from jsonb_array_elements(v_locations)
    loop
      if jsonb_typeof(v_location_item) <> 'object'
         or nullif(trim(v_location_item->>'region_code'), '') is null
         or nullif(trim(v_location_item->>'comuna_code'), '') is null
         or length(coalesce(v_location_item->>'region_code','')) > 10
         or length(coalesce(v_location_item->>'region_name','')) > 120
         or length(coalesce(v_location_item->>'comuna_code','')) > 10
         or length(coalesce(v_location_item->>'comuna_name','')) > 120
         or length(coalesce(v_location_item->>'address','')) > 500
         or length(coalesce(v_location_item->>'phone','')) > 50
         or length(coalesce(v_location_item->>'email','')) > 320 then
        raise exception using errcode = '22023', message = 'Every location requires canonical region_code and comuna_code';
      end if;
      if not exists (
        select 1
        from jsonb_array_elements(v_run.snapshot #> '{campaign,territories}') territory
        where territory->>'region_code' = v_location_item->>'region_code'
          and territory->>'comuna_code' = v_location_item->>'comuna_code'
      ) then
        raise exception using errcode = '22023', message = 'Candidate location is outside the requested territory';
      end if;
    end loop;

    if nullif(trim(v_candidate->>'phone'),'') is null
       and nullif(trim(v_candidate->>'email'),'') is null
       and nullif(trim(v_candidate->>'website'),'') is null then
      raise exception using errcode = '22023', message = 'Candidate requires phone, email or website';
    end if;

    if jsonb_typeof(v_candidate->'evidence') <> 'array'
       or jsonb_array_length(v_candidate->'evidence') not between 1 and 100 then
      raise exception using errcode = '22023', message = 'Candidate evidence must contain between 1 and 100 items';
    end if;

    if exists (
      select 1 from jsonb_array_elements(v_candidate->'evidence') e
      where e->>'provider' not in ('google_places','brave_search','official_website')
         or not exists (
           select 1 from jsonb_array_elements_text(v_run.snapshot #> '{campaign,sources}') configured(source)
           where configured.source = e->>'provider'
         )
         or (nullif(trim(e->>'source_url'),'') is null and nullif(trim(e->>'provider_record_id'),'') is null)
         or nullif(trim(e->>'field'),'') is null
         or nullif(trim(e->>'value'),'') is null
         or nullif(e->>'observed_at','') is null
         or length(coalesce(e->>'provider','')) > 40
         or length(coalesce(e->>'source_url','')) > 2048
         or length(coalesce(e->>'provider_record_id','')) > 2048
         or length(coalesce(e->>'field','')) > 80
         or length(coalesce(e->>'value','')) > 4000
         or length(coalesce(e->>'observed_at','')) > 64
         or not public.prospecting_valid_observed_at(e->>'observed_at')
    ) then
      raise exception using errcode = '22023', message = 'Evidence contains an invalid or untraceable item';
    end if;

    if jsonb_typeof(v_candidate->'provider_ids') = 'object' and (
      (select count(*) from jsonb_each_text(v_candidate->'provider_ids')) > 10
      or exists (
        select 1 from jsonb_each_text(v_candidate->'provider_ids') provider
        where length(provider.key) > 40 or length(provider.value) > 2048
           or not exists (
             select 1 from jsonb_array_elements_text(v_run.snapshot #> '{campaign,sources}') configured(source)
             where configured.source = provider.key
           )
      )
    ) then
      raise exception using errcode = '22023', message = 'Candidate provider_ids exceeds allowed size';
    end if;

    if not exists (
      select 1 from jsonb_array_elements(v_candidate->'evidence') evidence
      where evidence->>'field' = 'name'
        and public.normalize_prospect_name(evidence->>'value') = public.normalize_prospect_name(v_name)
    ) then
      raise exception using errcode = '22023', message = 'Candidate name lacks matching dated evidence';
    end if;

    for v_location_item, v_location_position in
      select value, (ordinality - 1)::integer
      from jsonb_array_elements(v_locations) with ordinality
    loop
      if not exists (
        select 1
        from jsonb_array_elements(v_candidate->'evidence') evidence
        join public.geo_comunas comuna on comuna.code = v_location_item->>'comuna_code'
        where (
          (evidence->>'field' ~ 'comuna_code$' and trim(evidence->>'value') = comuna.code)
          or (evidence->>'field' ~ 'comuna_name$'
              and public.normalize_prospect_text(evidence->>'value') = public.normalize_prospect_text(comuna.name))
        )
          and (
            jsonb_array_length(v_locations) = 1
            or evidence->>'field' in (
              format('locations[%s].comuna_code', v_location_position),
              format('locations[%s].comuna_name', v_location_position)
            )
          )
      ) then
        raise exception using errcode = '22023', message = 'Every location requires matching commune evidence';
      end if;
      if nullif(trim(v_location_item->>'address'), '') is not null and not exists (
        select 1 from jsonb_array_elements(v_candidate->'evidence') evidence
        where evidence->>'field' ~ '(^|\.)address$'
          and public.normalize_prospect_address(evidence->>'value') = public.normalize_prospect_address(v_location_item->>'address')
          and (
            jsonb_array_length(v_locations) = 1
            or evidence->>'field' = format('locations[%s].address', v_location_position)
          )
      ) then
        raise exception using errcode = '22023', message = 'Candidate address lacks matching dated evidence';
      end if;
    end loop;

    if nullif(trim(v_candidate->>'rut'), '') is not null and (
      public.normalize_prospect_rut(v_candidate->>'rut') is null or not exists (
        select 1 from jsonb_array_elements(v_candidate->'evidence') evidence
        where evidence->>'field' = 'rut'
          and public.normalize_prospect_rut(evidence->>'value') = public.normalize_prospect_rut(v_candidate->>'rut')
      )
    ) then
      raise exception using errcode = '22023', message = 'Candidate RUT is invalid or lacks matching evidence';
    end if;

    if nullif(trim(v_candidate->>'trade_name'), '') is not null and not exists (
      select 1 from jsonb_array_elements(v_candidate->'evidence') evidence
      where evidence->>'field' = 'trade_name'
        and public.normalize_prospect_text(evidence->>'value') = public.normalize_prospect_text(v_candidate->>'trade_name')
    ) then
      raise exception using errcode = '22023', message = 'Candidate trade_name lacks matching evidence';
    end if;

    if nullif(trim(v_candidate->>'description'), '') is not null and not exists (
      select 1 from jsonb_array_elements(v_candidate->'evidence') evidence
      where evidence->>'field' = 'description'
        and public.normalize_prospect_text(evidence->>'value') = public.normalize_prospect_text(v_candidate->>'description')
    ) then
      raise exception using errcode = '22023', message = 'Candidate description lacks matching evidence';
    end if;

    if nullif(trim(v_candidate->>'phone'), '') is not null and (
      public.normalize_prospect_phone(v_candidate->>'phone') is null or not exists (
        select 1 from jsonb_array_elements(v_candidate->'evidence') evidence
        where evidence->>'field' = 'phone'
          and public.normalize_prospect_phone(evidence->>'value') = public.normalize_prospect_phone(v_candidate->>'phone')
      )
    ) then
      raise exception using errcode = '22023', message = 'Candidate phone is invalid or lacks matching evidence';
    end if;

    if nullif(lower(trim(v_candidate->>'email')), '') is not null and not exists (
      select 1 from jsonb_array_elements(v_candidate->'evidence') evidence
      where evidence->>'field' = 'email'
        and lower(trim(evidence->>'value')) = lower(trim(v_candidate->>'email'))
    ) then
      raise exception using errcode = '22023', message = 'Candidate email lacks matching evidence';
    end if;

    if nullif(trim(v_candidate->>'website'), '') is not null and (
      public.normalize_prospect_domain(v_candidate->>'website') is null or not exists (
        select 1 from jsonb_array_elements(v_candidate->'evidence') evidence
        where evidence->>'field' = 'website'
          and public.normalize_prospect_domain(evidence->>'value') = public.normalize_prospect_domain(v_candidate->>'website')
      )
    ) then
      raise exception using errcode = '22023', message = 'Candidate website is invalid or lacks matching evidence';
    end if;

    if not (
      (nullif(trim(v_candidate->>'phone'), '') is not null and public.normalize_prospect_phone(v_candidate->>'phone') is not null)
      or nullif(lower(trim(v_candidate->>'email')), '') is not null
      or (nullif(trim(v_candidate->>'website'), '') is not null and public.normalize_prospect_domain(v_candidate->>'website') is not null)
    ) then
      raise exception using errcode = '22023', message = 'Candidate requires a valid evidenced contact';
    end if;

    v_name_normalized := public.normalize_prospect_name(v_name);
    v_rut_normalized := public.normalize_prospect_rut(v_candidate->>'rut');
    v_domain_normalized := public.normalize_prospect_domain(v_candidate->>'website');
    v_phone_normalized := public.normalize_prospect_phone(v_candidate->>'phone');
    v_address_normalized := public.normalize_prospect_address(v_location->>'address');
    v_score := nullif(v_candidate->>'score','')::numeric;
    if v_score is not null and (v_score < 0 or v_score > 100) then
      raise exception using errcode = '22023', message = 'Candidate score must be between 0 and 100';
    end if;

    v_entity_id := null;
    v_existing_run_entity_id := null;
    v_existing_candidate_row_id := null;
    v_existing_run_is_quarantine := false;
    v_identity_conflict := false;
    v_entity_hierarchy_conflict := false;
    v_company_hierarchy_conflict := false;
    v_entity_match_priority := null;
    v_company_match_priority := null;

    if nullif(v_candidate->>'candidate_id', '') is not null then
      select relation.id, relation.entity_id, exists (
        select 1 from jsonb_array_elements_text(
          case when jsonb_typeof(relation.candidate_snapshot->'review_flags') = 'array'
               then relation.candidate_snapshot->'review_flags' else '[]'::jsonb end
        ) flag
        where flag in ('conflicting_exact_identifiers','conflicting_exact_company_identifiers')
      )
      into v_existing_candidate_row_id, v_existing_run_entity_id, v_existing_run_is_quarantine
      from public.prospecting_campaign_candidates relation
      where relation.run_id = p_run_id
        and relation.external_candidate_id = v_candidate->>'candidate_id'
      limit 1;
    end if;

    -- Resolver todos los identificadores exactos antes de elegir la prioridad.
    -- Si apuntan a entidades diferentes, nunca se mezclan sus datos: el
    -- candidato se conserva en una entidad de cuarentena para revision humana.
    select coalesce(array_agg(distinct matches.entity_id), '{}'::uuid[])
    into v_exact_entity_ids
    from (
      select entity.id entity_id
      from public.prospect_entities entity
      where v_rut_normalized is not null and entity.rut_normalized = v_rut_normalized
      union all
      select source.entity_id
      from jsonb_each_text(case when jsonb_typeof(v_candidate->'provider_ids') = 'object'
                                then v_candidate->'provider_ids' else '{}'::jsonb end) provider
      join public.prospect_source_records source
        on source.provider = provider.key and source.provider_record_id = provider.value
      union all
      select source.entity_id
      from jsonb_array_elements(v_candidate->'evidence') evidence
      join public.prospect_source_records source
        on source.provider = evidence->>'provider'
       and source.provider_record_id = nullif(evidence->>'provider_record_id','')
      where nullif(evidence->>'provider_record_id','') is not null
      union all
      select entity.id
      from public.prospect_entities entity
      where v_domain_normalized is not null and entity.domain_normalized = v_domain_normalized
      union all
      select entity.id
      from public.prospect_entities entity
      where v_phone_normalized is not null and entity.phone_normalized = v_phone_normalized
      union all
      select entity.id
      from public.prospect_entities entity
      join public.prospect_locations location on location.entity_id = entity.id
      where entity.name_normalized = v_name_normalized
        and location.comuna_code = v_comuna_code
        and ((v_address_normalized is null and location.address_normalized is null)
             or location.address_normalized = v_address_normalized)
    ) matches;

    -- El CRM puede tener empresas historicas que el worker local desconoce.
    -- Sus identificadores tambien participan antes de tocar prospect_entities.
    select coalesce(array_agg(distinct matches.company_id), '{}'::uuid[])
    into v_exact_company_ids
    from (
      select company.id company_id from public.companies company
      where v_rut_normalized is not null
        and public.normalize_prospect_rut(company.rut) = v_rut_normalized
      union all
      select company.id from public.companies company
      where v_domain_normalized is not null
        and public.normalize_prospect_domain(company.website) = v_domain_normalized
      union all
      select company.id from public.companies company
      where v_phone_normalized is not null
        and (public.normalize_prospect_phone(company.phone) = v_phone_normalized
             or public.normalize_prospect_phone(company.whatsapp) = v_phone_normalized)
      union all
      select company.id
      from public.companies company
      left join public.company_locations location on location.company_id = company.id
      where public.normalize_prospect_name(company.name) = v_name_normalized
        and coalesce(location.comuna_code, company.comuna_code) = v_comuna_code
        and ((v_address_normalized is null
              and public.normalize_prospect_address(coalesce(location.address, company.address)) is null)
             or public.normalize_prospect_address(coalesce(location.address, company.address)) = v_address_normalized)
    ) matches;

    -- Una coincidencia de menor prioridad no puede absorber un identificador
    -- superior que contradice a la entidad encontrada. Por ejemplo: mismo
    -- telefono pero dominio distinto, o mismo dominio pero RUT distinto.
    if cardinality(v_exact_entity_ids) = 1 then
      select case
        when v_rut_normalized is not null and entity.rut_normalized = v_rut_normalized then 1
        when exists (
          select 1
          from jsonb_each_text(
            case when jsonb_typeof(v_candidate->'provider_ids') = 'object'
                 then v_candidate->'provider_ids' else '{}'::jsonb end
          ) provider
          join public.prospect_source_records source
            on source.entity_id = entity.id
           and source.provider = provider.key
           and source.provider_record_id = provider.value
           and source.field_name = 'provider_id'
          where nullif(trim(provider.value), '') is not null
            and (source.retention_until is null or source.retention_until > now())
        ) then 2
        when v_domain_normalized is not null and entity.domain_normalized = v_domain_normalized then 3
        when v_phone_normalized is not null and entity.phone_normalized = v_phone_normalized then 4
        else 5
      end
      into v_entity_match_priority
      from public.prospect_entities entity
      where entity.id = v_exact_entity_ids[1];

      select
        (v_entity_match_priority > 1
         and v_rut_normalized is not null
         and entity.rut_normalized is not null
         and entity.rut_normalized <> v_rut_normalized)
        or
        (v_entity_match_priority >= 2 and exists (
          select 1
          from jsonb_each_text(
            case when jsonb_typeof(v_candidate->'provider_ids') = 'object'
                 then v_candidate->'provider_ids' else '{}'::jsonb end
          ) provider
          where nullif(trim(provider.value), '') is not null
            and exists (
              select 1 from public.prospect_source_records source
              where source.entity_id = entity.id
                and source.provider = provider.key
                and source.field_name = 'provider_id'
                and source.provider_record_id is not null
                and (source.retention_until is null or source.retention_until > now())
            )
            and not exists (
              select 1 from public.prospect_source_records source
              where source.entity_id = entity.id
                and source.provider = provider.key
                and source.field_name = 'provider_id'
                and source.provider_record_id = provider.value
                and (source.retention_until is null or source.retention_until > now())
            )
        ))
        or
        (v_entity_match_priority > 3
         and v_domain_normalized is not null
         and entity.domain_normalized is not null
         and entity.domain_normalized <> v_domain_normalized)
        or
        (v_entity_match_priority > 4
         and v_phone_normalized is not null
         and entity.phone_normalized is not null
         and entity.phone_normalized <> v_phone_normalized)
      into v_entity_hierarchy_conflict
      from public.prospect_entities entity
      where entity.id = v_exact_entity_ids[1];
    end if;

    -- Las empresas historicas no guardan IDs de proveedor, pero aplican la
    -- misma jerarquia RUT > dominio > telefono > nombre+ubicacion.
    if cardinality(v_exact_company_ids) = 1 then
      select case
        when v_rut_normalized is not null
             and public.normalize_prospect_rut(company.rut) = v_rut_normalized then 1
        when v_domain_normalized is not null
             and public.normalize_prospect_domain(company.website) = v_domain_normalized then 3
        when v_phone_normalized is not null
             and (public.normalize_prospect_phone(company.phone) = v_phone_normalized
                  or public.normalize_prospect_phone(company.whatsapp) = v_phone_normalized) then 4
        else 5
      end
      into v_company_match_priority
      from public.companies company
      where company.id = v_exact_company_ids[1];

      select
        (v_company_match_priority > 1
         and v_rut_normalized is not null
         and public.normalize_prospect_rut(company.rut) is not null
         and public.normalize_prospect_rut(company.rut) <> v_rut_normalized)
        or
        (v_company_match_priority > 3
         and v_domain_normalized is not null
         and public.normalize_prospect_domain(company.website) is not null
         and public.normalize_prospect_domain(company.website) <> v_domain_normalized)
        or
        (v_company_match_priority > 4
         and v_phone_normalized is not null
         and (public.normalize_prospect_phone(company.phone) is not null
              or public.normalize_prospect_phone(company.whatsapp) is not null)
         and public.normalize_prospect_phone(company.phone) is distinct from v_phone_normalized
         and public.normalize_prospect_phone(company.whatsapp) is distinct from v_phone_normalized)
      into v_company_hierarchy_conflict
      from public.companies company
      where company.id = v_exact_company_ids[1];
    end if;

    v_identity_conflict := cardinality(v_exact_entity_ids) > 1
      or cardinality(v_exact_company_ids) > 1
      or v_entity_hierarchy_conflict
      or v_company_hierarchy_conflict;
    if v_identity_conflict then
      v_entity_id := case when v_existing_run_is_quarantine then v_existing_run_entity_id else null end;
      v_candidate := jsonb_set(v_candidate, '{dedup_disposition}', to_jsonb('possible_duplicate'::text), true);
      if cardinality(v_exact_entity_ids) > 1 or v_entity_hierarchy_conflict then
        v_candidate := jsonb_set(
          v_candidate,
          '{review_flags}',
          coalesce(v_candidate->'review_flags', '[]'::jsonb)
            || jsonb_build_array('conflicting_exact_identifiers'),
          true
        );
        v_candidate := jsonb_set(v_candidate, '{conflicting_entity_ids}', to_jsonb(v_exact_entity_ids), true);
      end if;
      if cardinality(v_exact_company_ids) > 1 or v_company_hierarchy_conflict then
        v_candidate := jsonb_set(
          v_candidate,
          '{review_flags}',
          coalesce(v_candidate->'review_flags', '[]'::jsonb)
            || jsonb_build_array('conflicting_exact_company_identifiers'),
          true
        );
        v_candidate := jsonb_set(v_candidate, '{conflicting_company_ids}', to_jsonb(v_exact_company_ids), true);
      end if;
    else
      v_entity_id := coalesce(v_existing_run_entity_id, v_exact_entity_ids[1]);
    end if;

    -- El limite cuenta candidatos nuevos, no reenvios/enriquecimientos de uno
    -- ya aceptado en el mismo run.
    if (select count(*) from public.prospecting_campaign_candidates where run_id = p_run_id) >= v_limit
       and v_existing_candidate_row_id is null
       and not exists (
         select 1 from public.prospecting_campaign_candidates relation
         where relation.run_id = p_run_id and relation.entity_id = v_entity_id
       ) then
      v_rejected_limit := v_rejected_limit + 1;
      continue;
    end if;

    if v_entity_id is null and v_identity_conflict then
      insert into public.prospect_entities (name, name_normalized, relevance_score)
      values (v_name, v_name_normalized, v_score)
      returning id into v_entity_id;
      if v_existing_candidate_row_id is not null then
        update public.prospecting_campaign_candidates
        set entity_id = v_entity_id,
            review_status = 'possible_duplicate',
            candidate_snapshot = candidate_snapshot || jsonb_strip_nulls(v_candidate - 'evidence')
        where id = v_existing_candidate_row_id;

        update public.prospect_source_records
        set entity_id = v_entity_id, location_id = null
        where run_id = p_run_id
          and metadata->>'candidate_id' = v_candidate->>'candidate_id';
      end if;
    elsif v_entity_id is null then
      insert into public.prospect_entities (
        name, name_normalized, legal_name, rut, rut_normalized, business_line,
        company_type, website, domain_normalized, phone, phone_normalized,
        email, description, relevance_score
      ) values (
        v_name, v_name_normalized, nullif(trim(v_candidate->>'trade_name'),''),
        nullif(trim(v_candidate->>'rut'),''), v_rut_normalized,
        nullif(trim(v_candidate->>'category'),''), nullif(trim(v_candidate->>'category'),''),
        nullif(trim(v_candidate->>'website'),''), v_domain_normalized,
        nullif(trim(v_candidate->>'phone'),''), v_phone_normalized,
        nullif(lower(trim(v_candidate->>'email')),''), nullif(trim(v_candidate->>'description'),''),
        v_score
      ) on conflict do nothing
      returning id into v_entity_id;

      if v_entity_id is null then
        select id into v_entity_id from public.prospect_entities
        where (v_rut_normalized is not null and rut_normalized = v_rut_normalized)
           or (v_domain_normalized is not null and domain_normalized = v_domain_normalized)
           or (v_phone_normalized is not null and phone_normalized = v_phone_normalized)
        order by case when rut_normalized = v_rut_normalized then 1
                      when domain_normalized = v_domain_normalized then 2 else 3 end
        limit 1;
      end if;
    elsif not v_identity_conflict then
      update public.prospect_entities e
      set name = case when length(v_name) > length(e.name) then v_name else e.name end,
          legal_name = coalesce(e.legal_name, nullif(trim(v_candidate->>'trade_name'),'')),
          rut = coalesce(e.rut, nullif(trim(v_candidate->>'rut'),'')),
          rut_normalized = case
            when e.rut_normalized is not null then e.rut_normalized
            when not exists (select 1 from public.prospect_entities x where x.rut_normalized = v_rut_normalized and x.id <> e.id) then v_rut_normalized
            else null end,
          business_line = coalesce(e.business_line, nullif(trim(v_candidate->>'category'),'')),
          company_type = coalesce(e.company_type, nullif(trim(v_candidate->>'category'),'')),
          website = coalesce(e.website, nullif(trim(v_candidate->>'website'),'')),
          domain_normalized = case
            when e.domain_normalized is not null then e.domain_normalized
            when not exists (select 1 from public.prospect_entities x where x.domain_normalized = v_domain_normalized and x.id <> e.id) then v_domain_normalized
            else null end,
          phone = coalesce(e.phone, nullif(trim(v_candidate->>'phone'),'')),
          phone_normalized = case
            when e.phone_normalized is not null then e.phone_normalized
            when not exists (select 1 from public.prospect_entities x where x.phone_normalized = v_phone_normalized and x.id <> e.id) then v_phone_normalized
            else null end,
          email = coalesce(e.email, nullif(lower(trim(v_candidate->>'email')),'')),
          description = coalesce(e.description, nullif(trim(v_candidate->>'description'),'')),
          relevance_score = case when v_score is null then e.relevance_score else greatest(coalesce(e.relevance_score, 0), v_score) end
      where e.id = v_entity_id;
    end if;

    if v_entity_id is null then
      raise exception using errcode = '23505', message = 'Could not resolve candidate after exact deduplication';
    end if;

    v_primary_location_id := null;
    for v_location_item in select value from jsonb_array_elements(v_locations)
    loop
      v_region_code := nullif(trim(v_location_item->>'region_code'), '');
      v_comuna_code := nullif(trim(v_location_item->>'comuna_code'), '');
      v_address_normalized := public.normalize_prospect_address(v_location_item->>'address');
      v_location_id := null;

      select id into v_location_id
      from public.prospect_locations
      where entity_id = v_entity_id
        and comuna_code = v_comuna_code
        and coalesce(address_normalized,'') = coalesce(v_address_normalized,'')
      limit 1;

      if v_location_id is null then
        insert into public.prospect_locations (
          entity_id, kind, region_code, comuna_code, address, address_normalized,
          latitude, longitude, phone, email, is_primary
        ) values (
          v_entity_id,
          case when not exists (select 1 from public.prospect_locations where entity_id = v_entity_id)
               then 'headquarters'
               when v_location_item->>'kind' in ('headquarters','branch') then v_location_item->>'kind'
               else 'branch' end,
          v_region_code, v_comuna_code, nullif(trim(v_location_item->>'address'),''), v_address_normalized,
          nullif(v_location_item->>'latitude','')::numeric, nullif(v_location_item->>'longitude','')::numeric,
          coalesce(nullif(trim(v_location_item->>'phone'),''), nullif(trim(v_candidate->>'phone'),'')),
          coalesce(nullif(lower(trim(v_location_item->>'email')),''), nullif(lower(trim(v_candidate->>'email')),'')),
          not exists (select 1 from public.prospect_locations where entity_id = v_entity_id)
        ) on conflict do nothing returning id into v_location_id;

        if v_location_id is null then
          select id into v_location_id
          from public.prospect_locations
          where entity_id = v_entity_id
            and comuna_code = v_comuna_code
            and coalesce(address_normalized,'') = coalesce(v_address_normalized,'')
          limit 1;
        end if;
        if v_location_id is null then
          insert into public.prospect_locations (
            entity_id, kind, region_code, comuna_code, address, address_normalized,
            latitude, longitude, phone, email, is_primary
          ) values (
            v_entity_id, 'branch', v_region_code, v_comuna_code,
            nullif(trim(v_location_item->>'address'),''), v_address_normalized,
            nullif(v_location_item->>'latitude','')::numeric, nullif(v_location_item->>'longitude','')::numeric,
            coalesce(nullif(trim(v_location_item->>'phone'),''), nullif(trim(v_candidate->>'phone'),'')),
            coalesce(nullif(lower(trim(v_location_item->>'email')),''), nullif(lower(trim(v_candidate->>'email')),'')),
            false
          ) on conflict do nothing returning id into v_location_id;
        end if;
        if v_location_id is null then
          select id into v_location_id
          from public.prospect_locations
          where entity_id = v_entity_id
            and comuna_code = v_comuna_code
            and coalesce(address_normalized,'') = coalesce(v_address_normalized,'')
          limit 1;
        end if;
      else
        update public.prospect_locations
        set address = coalesce(address, nullif(trim(v_location_item->>'address'),'')),
            latitude = coalesce(latitude, nullif(v_location_item->>'latitude','')::numeric),
            longitude = coalesce(longitude, nullif(v_location_item->>'longitude','')::numeric),
            phone = coalesce(phone, nullif(trim(v_location_item->>'phone'),''), nullif(trim(v_candidate->>'phone'),'')),
            email = coalesce(email, nullif(lower(trim(v_location_item->>'email')),''), nullif(lower(trim(v_candidate->>'email')),''))
        where id = v_location_id;
      end if;

      if v_primary_location_id is null and v_location_item = v_location then
        v_primary_location_id := v_location_id;
      end if;
    end loop;

    if v_primary_location_id is null then
      raise exception using errcode = '55000', message = 'Candidate locations could not be persisted';
    end if;
    v_location_id := v_primary_location_id;
    v_region_code := nullif(trim(v_location->>'region_code'), '');
    v_comuna_code := nullif(trim(v_location->>'comuna_code'), '');
    v_address_normalized := public.normalize_prospect_address(v_location->>'address');

    if jsonb_typeof(v_candidate->'provider_ids') = 'object' then
      for v_evidence in
        select jsonb_build_object(
          'provider', provider.key,
          'provider_record_id', provider.value,
          'field', 'provider_id',
          'value', provider.value,
          'observed_at', now(),
          'confidence', 1
        ) from jsonb_each_text(v_candidate->'provider_ids') provider
      loop
        if v_evidence->>'provider' in ('google_places','brave_search','official_website') then
          insert into public.prospect_source_records (
            entity_id, run_id, location_id, provider, provider_record_id,
            field_name, field_value, confidence, observed_at, retention_until, metadata
          ) values (
            v_entity_id, p_run_id, v_location_id, v_evidence->>'provider', v_evidence->>'provider_record_id',
            'provider_id', v_evidence->>'value', 1, now(),
            case when v_evidence->>'provider' = 'google_places' then now() + interval '30 days' else null end,
            jsonb_build_object('candidate_id', v_candidate->>'candidate_id')
          ) on conflict (run_id, provider, provider_record_id, field_name)
            where run_id is not null and provider_record_id is not null
          do update set last_seen_at = now();
        end if;
      end loop;
    end if;

    for v_evidence in select value from jsonb_array_elements(v_candidate->'evidence')
    loop
      v_provider_record_id := coalesce(
        nullif(v_evidence->>'provider_record_id',''),
        nullif(v_candidate->'provider_ids'->>(v_evidence->>'provider'),'')
      );
      v_evidence_location_id := v_location_id;
      v_evidence_location_index := nullif(
        substring(v_evidence->>'field' from '^locations?\[([0-9]+)\]\.'),
        ''
      )::integer;
      if v_evidence_location_index is not null
         and v_evidence_location_index >= 0
         and v_evidence_location_index < jsonb_array_length(v_locations) then
        v_location_item := v_locations->v_evidence_location_index;
        select location.id into v_evidence_location_id
        from public.prospect_locations location
        where location.entity_id = v_entity_id
          and location.region_code = v_location_item->>'region_code'
          and location.comuna_code = v_location_item->>'comuna_code'
          and coalesce(location.address_normalized, '') = coalesce(
            public.normalize_prospect_address(v_location_item->>'address'), ''
          )
        limit 1;
        v_evidence_location_id := coalesce(v_evidence_location_id, v_location_id);
      end if;
      insert into public.prospect_source_records (
        entity_id, run_id, location_id, provider, provider_record_id, source_url,
        field_name, field_value, confidence, observed_at, retention_until, metadata
      ) values (
        v_entity_id, p_run_id, v_evidence_location_id, v_evidence->>'provider', v_provider_record_id,
        nullif(trim(v_evidence->>'source_url'),''), trim(v_evidence->>'field'),
        v_evidence->>'value', coalesce(nullif(v_evidence->>'confidence','')::numeric, 1),
        (v_evidence->>'observed_at')::timestamptz,
        case when v_evidence->>'provider' = 'google_places'
             then least((v_evidence->>'observed_at')::timestamptz, now()) + interval '30 days'
             else null end,
        jsonb_build_object('candidate_id', v_candidate->>'candidate_id')
      ) on conflict (run_id, provider, provider_record_id, field_name)
        where run_id is not null and provider_record_id is not null
      do update set
        entity_id = excluded.entity_id,
        location_id = excluded.location_id,
        source_url = coalesce(excluded.source_url, public.prospect_source_records.source_url),
        field_value = excluded.field_value,
        confidence = excluded.confidence,
        observed_at = excluded.observed_at,
        retention_until = excluded.retention_until,
        last_seen_at = now();
    end loop;

    v_duplicate_company_id := null;
    select coalesce(array_agg(distinct matches.company_id), '{}'::uuid[])
    into v_exact_company_ids
    from (
      select company.id company_id from public.companies company
      where v_rut_normalized is not null
        and public.normalize_prospect_rut(company.rut) = v_rut_normalized
      union all
      select company.id from public.companies company
      where v_domain_normalized is not null
        and public.normalize_prospect_domain(company.website) = v_domain_normalized
      union all
      select company.id from public.companies company
      where v_phone_normalized is not null
        and (public.normalize_prospect_phone(company.phone) = v_phone_normalized
             or public.normalize_prospect_phone(company.whatsapp) = v_phone_normalized)
      union all
      select company.id
      from public.companies company
      left join public.company_locations location on location.company_id = company.id
      where public.normalize_prospect_name(company.name) = v_name_normalized
        and coalesce(location.comuna_code, company.comuna_code) = v_comuna_code
        and ((v_address_normalized is null
              and public.normalize_prospect_address(coalesce(location.address, company.address)) is null)
             or public.normalize_prospect_address(coalesce(location.address, company.address)) = v_address_normalized)
    ) matches;

    if cardinality(v_exact_company_ids) = 1 then
      v_duplicate_company_id := v_exact_company_ids[1];
    elsif cardinality(v_exact_company_ids) > 1 then
      v_candidate := jsonb_set(v_candidate, '{dedup_disposition}', to_jsonb('possible_duplicate'::text), true);
      v_candidate := jsonb_set(
        v_candidate,
        '{review_flags}',
        coalesce(v_candidate->'review_flags', '[]'::jsonb)
          || jsonb_build_array('conflicting_exact_company_identifiers'),
        true
      );
      v_candidate := jsonb_set(v_candidate, '{conflicting_company_ids}', to_jsonb(v_exact_company_ids), true);
    end if;

    v_review_status := case
      when v_duplicate_company_id is not null
        or v_candidate->>'dedup_disposition' = 'possible_duplicate'
      then 'possible_duplicate' else 'pending' end;

    select id into v_candidate_row_id
    from public.prospecting_campaign_candidates
    where run_id = p_run_id and entity_id = v_entity_id;

    if v_candidate_row_id is null then
      insert into public.prospecting_campaign_candidates (
        campaign_id, run_id, entity_id, candidate_snapshot, external_candidate_id, possible_duplicate_of,
        possible_duplicate_company_id, review_status, score
      ) values (
        v_run.campaign_id, p_run_id, v_entity_id,
        jsonb_strip_nulls(v_candidate - 'evidence'),
        nullif(v_candidate->>'candidate_id',''),
        nullif(v_candidate->>'possible_duplicate_of',''), v_duplicate_company_id,
        v_review_status, v_score
      ) returning id into v_candidate_row_id;
    else
      update public.prospecting_campaign_candidates
      set last_seen_at = now(),
          candidate_snapshot = candidate_snapshot || jsonb_strip_nulls(v_candidate - 'evidence'),
          score = case when v_score is null then score else greatest(coalesce(score, 0), v_score) end,
          review_status = case when review_status = 'pending' and v_review_status = 'possible_duplicate'
                               then 'possible_duplicate' else review_status end,
          external_candidate_id = coalesce(external_candidate_id, nullif(v_candidate->>'candidate_id','')),
          possible_duplicate_of = coalesce(possible_duplicate_of, nullif(v_candidate->>'possible_duplicate_of',''))
          , possible_duplicate_company_id = coalesce(possible_duplicate_company_id, v_duplicate_company_id)
      where id = v_candidate_row_id;
    end if;

    v_accepted := v_accepted + 1;
  end loop;

  update public.prospecting_runs
  set candidates_found = (select count(*) from public.prospecting_campaign_candidates where run_id = p_run_id)
  where id = p_run_id;

  return jsonb_build_object(
    'accepted', v_accepted,
    'rejected_limit', v_rejected_limit,
    'limit_reached', v_rejected_limit > 0,
    'candidates_found', (select count(*) from public.prospecting_campaign_candidates where run_id = p_run_id)
  );
end;
$$;

create or replace function public.complete_prospecting_run(
  p_run_id uuid,
  p_api_key_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_status text,
  p_stats jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.prospecting_runs%rowtype;
  v_status text := p_status;
  v_completed integer;
  v_failed integer;
  v_limit_reached boolean := lower(coalesce(p_stats->>'limit_reached', 'false')) = 'true';
begin
  if v_status not in ('completed','partial','cancelled') then
    raise exception using errcode = '22023', message = 'Completion status must be completed, partial or cancelled';
  end if;
  select * into v_run from public.prospecting_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Prospecting run not found'; end if;
  if v_run.status in ('completed','partial','cancelled')
     and v_run.claimed_by_api_key is not distinct from p_api_key_id
     and v_run.claimed_by_worker is not distinct from trim(p_worker_id) then
    return jsonb_build_object(
      'id', p_run_id,
      'status', v_run.status,
      'completed_tasks', v_run.completed_tasks,
      'failed_tasks', v_run.failed_tasks
    );
  end if;
  if v_run.claimed_by_api_key is distinct from p_api_key_id
     or v_run.claimed_by_worker is distinct from trim(p_worker_id)
     or v_run.lease_token is distinct from p_lease_token
     or v_run.lease_expires_at is null or v_run.lease_expires_at <= now()
     or v_run.status not in ('running','cancel_requested') then
    raise exception using errcode = '42501', message = 'Invalid run lease';
  end if;

  if v_run.status = 'cancel_requested' then v_status := 'cancelled'; end if;

  -- Reaching the configured cap is a successful bounded execution. Tasks not
  -- queried after the cap are terminally cancelled, not reported as errors.
  if v_limit_reached and v_status in ('completed','partial') then
    update public.prospecting_tasks
    set status = 'cancelled', completed_at = now(),
        last_error = coalesce(last_error, 'Candidate limit reached')
    where run_id = p_run_id and status in ('pending','running');
  end if;

  if v_status = 'completed' and exists (
    select 1 from public.prospecting_tasks
    where run_id = p_run_id and status not in ('completed','cancelled')
  ) then
    raise exception using errcode = '55000', message = 'Run cannot be completed while tasks are non-terminal';
  end if;

  if v_status = 'partial' and not v_limit_reached then
    update public.prospecting_tasks
    set status = 'failed', completed_at = now(), last_error = coalesce(last_error, 'Run completed partially')
    where run_id = p_run_id and status in ('pending','running');
  elsif v_status = 'cancelled' then
    update public.prospecting_tasks
    set status = 'cancelled', completed_at = now()
    where run_id = p_run_id and status in ('pending','running');
  end if;

  select count(*) filter (where status = 'completed')::integer,
         count(*) filter (where status = 'failed')::integer
  into v_completed, v_failed
  from public.prospecting_tasks where run_id = p_run_id;

  update public.prospecting_runs
  set status = v_status,
      completed_tasks = v_completed,
      failed_tasks = v_failed,
      candidates_found = (select count(*) from public.prospecting_campaign_candidates where run_id = p_run_id),
      progress = coalesce(p_stats, '{}'::jsonb) || jsonb_build_object(
        'percent', 100, 'completed_tasks', v_completed, 'failed_tasks', v_failed
      ),
      completed_at = now(), heartbeat_at = now(), lease_token = null, lease_expires_at = null
  where id = p_run_id;

  insert into public.prospecting_events (run_id, level, stage, message, metrics)
  values (p_run_id, case when v_status = 'partial' then 'warning' else 'info' end,
          v_status, 'Worker finalized prospecting run', coalesce(p_stats, '{}'::jsonb));

  return jsonb_build_object('id', p_run_id, 'status', v_status,
    'completed_tasks', v_completed, 'failed_tasks', v_failed);
end;
$$;

create or replace function public.fail_prospecting_run(
  p_run_id uuid,
  p_api_key_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.prospecting_runs%rowtype;
  v_error text := left(trim(coalesce(p_error, 'Unknown worker error')), 4000);
begin
  select * into v_run from public.prospecting_runs where id = p_run_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Prospecting run not found'; end if;
  if v_run.status = 'failed'
     and v_run.claimed_by_api_key is not distinct from p_api_key_id
     and v_run.claimed_by_worker is not distinct from trim(p_worker_id) then
    return jsonb_build_object(
      'id', p_run_id,
      'status', 'failed',
      'error', v_run.last_error
    );
  end if;
  if v_run.claimed_by_api_key is distinct from p_api_key_id
     or v_run.claimed_by_worker is distinct from trim(p_worker_id)
     or v_run.lease_token is distinct from p_lease_token
     or v_run.lease_expires_at is null or v_run.lease_expires_at <= now()
     or v_run.status not in ('running','cancel_requested') then
    raise exception using errcode = '42501', message = 'Invalid run lease';
  end if;

  update public.prospecting_tasks
  set status = 'failed', completed_at = now(), last_error = coalesce(last_error, v_error)
  where run_id = p_run_id and status in ('pending','running');

  update public.prospecting_runs
  set status = 'failed', last_error = v_error, completed_at = now(), heartbeat_at = now(),
      failed_tasks = (select count(*) from public.prospecting_tasks where run_id = p_run_id and status = 'failed'),
      lease_token = null, lease_expires_at = null
  where id = p_run_id;

  insert into public.prospecting_events (run_id, level, stage, message)
  values (p_run_id, 'error', 'failed', v_error);

  return jsonb_build_object('id', p_run_id, 'status', 'failed', 'error', v_error);
end;
$$;

-- La aprobacion y el enlace ocurren en una sola transaccion. Una coincidencia
-- exacta con una empresa existente se vincula; una sugerencia difusa nunca se
-- fusiona automaticamente y debe llegar con p_action = 'link'.
create or replace function public.review_prospect_candidate(
  p_candidate_id uuid,
  p_action text,
  p_company_id uuid default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate public.prospecting_campaign_candidates%rowtype;
  v_entity public.prospect_entities%rowtype;
  v_location public.prospect_locations%rowtype;
  v_each_location public.prospect_locations%rowtype;
  v_company_id uuid;
  v_company_location_id uuid;
  v_created_company boolean := false;
  v_review_status text;
  v_region_name text;
  v_comuna_name text;
  v_source text;
  v_company_type public.company_type;
  v_rut_normalized text;
  v_domain_normalized text;
  v_phone_normalized text;
  v_snapshot jsonb;
  v_snapshot_location jsonb;
  v_snapshot_locations jsonb;
  v_import_name text;
  v_import_legal_name text;
  v_import_rut text;
  v_import_business_line text;
  v_import_website text;
  v_import_phone text;
  v_import_email text;
  v_import_description text;
  v_import_address text;
  v_each_import_address text;
  v_existing_entity_company_id uuid;
  v_exact_company_ids uuid[];
begin
  perform public.prospecting_require_roles(array['administrador','vendedor']);
  if p_action not in ('approve','link','reject') then
    raise exception using errcode = '22023', message = 'action must be approve, link or reject';
  end if;

  select * into v_candidate
  from public.prospecting_campaign_candidates
  where id = p_candidate_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Prospect candidate not found';
  end if;

  if v_candidate.review_status in ('approved','linked','rejected') then
    if (p_action = 'reject' and v_candidate.review_status = 'rejected')
       or (p_action in ('approve','link') and v_candidate.review_status in ('approved','linked')) then
      return jsonb_build_object(
        'candidate_id', v_candidate.id,
        'review_status', v_candidate.review_status,
        'company_id', v_candidate.company_id,
        'created_company', false,
        'company_location_id', null
      );
    end if;
    raise exception using errcode = '55000', message = 'Candidate was already reviewed with a different decision';
  end if;

  if p_action = 'reject' then
    update public.prospecting_campaign_candidates
    set review_status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(),
        review_notes = nullif(trim(p_notes),'')
    where id = p_candidate_id;
    return jsonb_build_object(
      'candidate_id', p_candidate_id, 'review_status', 'rejected',
      'company_id', null, 'created_company', false, 'company_location_id', null
    );
  end if;

  select * into v_entity from public.prospect_entities where id = v_candidate.entity_id for update;
  v_snapshot := coalesce(v_candidate.candidate_snapshot, '{}'::jsonb);
  if jsonb_typeof(v_snapshot->'location') = 'object' then
    v_snapshot_location := v_snapshot->'location';
  elsif jsonb_typeof(v_snapshot->'locations') = 'array'
        and jsonb_array_length(v_snapshot->'locations') > 0 then
    v_snapshot_location := v_snapshot->'locations'->0;
  else
    v_snapshot_location := '{}'::jsonb;
  end if;

  if jsonb_typeof(v_snapshot->'locations') = 'array'
     and jsonb_array_length(v_snapshot->'locations') > 0 then
    v_snapshot_locations := v_snapshot->'locations';
  elsif jsonb_typeof(v_snapshot_location) = 'object'
        and v_snapshot_location <> '{}'::jsonb then
    v_snapshot_locations := jsonb_build_array(v_snapshot_location);
  else
    v_snapshot_locations := '[]'::jsonb;
  end if;

  -- La primera sede del payload puede ser temporal. Elegir como canonica la
  -- primera que el propio CRM pueda acreditar permanentemente para este run;
  -- importable_location_indexes es informativo y no se confia a ciegas.
  select coalesce((
    select snapshot_location.item
    from jsonb_array_elements(v_snapshot_locations)
      with ordinality snapshot_location(item, position)
    join public.prospect_locations location
      on location.entity_id = v_entity.id
     and location.region_code = snapshot_location.item->>'region_code'
     and location.comuna_code = snapshot_location.item->>'comuna_code'
     and coalesce(location.address_normalized, '') = coalesce(
           public.normalize_prospect_address(snapshot_location.item->>'address'), ''
         )
    where exists (
      select 1 from public.prospect_source_records evidence
      where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
        and evidence.location_id = location.id
        and evidence.provider in ('brave_search','official_website')
        and (
          (evidence.field_name ~ 'comuna_code$' and trim(evidence.field_value) = location.comuna_code)
          or (evidence.field_name ~ 'comuna_name$' and exists (
            select 1 from public.geo_comunas comuna
            where comuna.code = location.comuna_code
              and public.normalize_prospect_text(evidence.field_value)
                  = public.normalize_prospect_text(comuna.name)
          ))
        )
        and (evidence.retention_until is null or evidence.retention_until > now())
    )
      and (
        (select count(*) from jsonb_array_elements(v_snapshot_locations) same_comuna
         where same_comuna->>'comuna_code' = snapshot_location.item->>'comuna_code') <= 1
        or (
          nullif(trim(snapshot_location.item->>'address'), '') is not null
          and exists (
            select 1 from public.prospect_source_records evidence
            where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
              and evidence.location_id = location.id
              and evidence.provider in ('brave_search','official_website')
              and evidence.field_name ~ '(^|\.)address$'
              and public.normalize_prospect_address(evidence.field_value)
                  = public.normalize_prospect_address(snapshot_location.item->>'address')
              and (evidence.retention_until is null or evidence.retention_until > now())
          )
        )
      )
    order by snapshot_location.position
    limit 1
  ), v_snapshot_location)
  into v_snapshot_location;

  select * into v_location
  from public.prospect_locations location
  where location.entity_id = v_entity.id
    and (
      v_snapshot_location = '{}'::jsonb
      or (
        location.region_code = v_snapshot_location->>'region_code'
        and location.comuna_code = v_snapshot_location->>'comuna_code'
        and coalesce(location.address_normalized, '') = coalesce(
          public.normalize_prospect_address(v_snapshot_location->>'address'), ''
        )
      )
    )
  order by location.is_primary desc, location.created_at
  limit 1;
  if v_location.id is null and v_snapshot_location <> '{}'::jsonb then
    select * into v_location
    from public.prospect_locations location
    where location.entity_id = v_entity.id
      and location.region_code = v_snapshot_location->>'region_code'
      and location.comuna_code = v_snapshot_location->>'comuna_code'
    order by location.is_primary desc, location.created_at
    limit 1;
  end if;
  if v_location.id is null then
    raise exception using errcode = '55000', message = 'Candidate has no canonical location';
  end if;

  if v_snapshot = '{}'::jsonb then
    v_snapshot := jsonb_strip_nulls(jsonb_build_object(
      'name', v_entity.name, 'trade_name', v_entity.legal_name, 'rut', v_entity.rut,
      'phone', v_entity.phone, 'email', v_entity.email, 'website', v_entity.website,
      'category', v_entity.company_type, 'description', v_entity.description,
      'location', jsonb_build_object(
        'country_code', 'CL', 'region_code', v_location.region_code,
        'comuna_code', v_location.comuna_code, 'address', v_location.address
      )
    ));
    v_snapshot_location := v_snapshot->'location';
    v_snapshot_locations := jsonb_build_array(v_snapshot_location);
  end if;

  v_import_name := nullif(trim(v_snapshot->>'name'), '');
  v_import_legal_name := null;
  v_import_rut := null;
  v_import_business_line := nullif(trim(v_snapshot->>'category'), '');
  v_import_phone := null;
  v_import_email := null;
  v_import_website := null;
  v_import_description := null;
  v_import_address := null;

  select region.name, comuna.name into v_region_name, v_comuna_name
  from public.geo_comunas comuna
  join public.geo_regions region on region.code = comuna.region_code
  where comuna.code = v_location.comuna_code;

  -- Aprobar o vincular materializa datos permanentes: cada valor copiado debe
  -- estar respaldado, dentro de este mismo run, por Brave o el sitio oficial.
  -- Google Places por si solo nunca puede crear datos duraderos en companies.
  if not exists (
      select 1 from public.prospect_source_records evidence
      where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
        and evidence.provider in ('brave_search','official_website')
        and evidence.field_name = 'name'
        and public.normalize_prospect_name(evidence.field_value) = public.normalize_prospect_name(v_import_name)
        and (evidence.retention_until is null or evidence.retention_until > now())
    ) or not exists (
      select 1 from public.prospect_source_records evidence
      where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
        and evidence.location_id = v_location.id
        and evidence.provider in ('brave_search','official_website')
        and (
          (evidence.field_name ~ 'comuna_code$' and trim(evidence.field_value) = v_location.comuna_code)
          or (evidence.field_name ~ 'comuna_name$'
              and public.normalize_prospect_text(evidence.field_value) = public.normalize_prospect_text(v_comuna_name))
        )
        and (evidence.retention_until is null or evidence.retention_until > now())
    ) then
    raise exception using errcode = '55000', message = 'Candidate lacks permanent name or territory evidence for this run';
  end if;

  if nullif(trim(v_snapshot->>'phone'), '') is not null and exists (
    select 1 from public.prospect_source_records evidence
    where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
      and evidence.provider in ('brave_search','official_website') and evidence.field_name = 'phone'
      and public.normalize_prospect_phone(evidence.field_value) = public.normalize_prospect_phone(v_snapshot->>'phone')
      and (evidence.retention_until is null or evidence.retention_until > now())
  ) then v_import_phone := v_snapshot->>'phone'; end if;

  if nullif(lower(trim(v_snapshot->>'email')), '') is not null and exists (
    select 1 from public.prospect_source_records evidence
    where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
      and evidence.provider in ('brave_search','official_website') and evidence.field_name = 'email'
      and lower(trim(evidence.field_value)) = lower(trim(v_snapshot->>'email'))
      and (evidence.retention_until is null or evidence.retention_until > now())
  ) then v_import_email := lower(trim(v_snapshot->>'email')); end if;

  if nullif(trim(v_snapshot->>'website'), '') is not null and exists (
    select 1 from public.prospect_source_records evidence
    where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
      and evidence.provider in ('brave_search','official_website') and evidence.field_name = 'website'
      and public.normalize_prospect_domain(evidence.field_value) = public.normalize_prospect_domain(v_snapshot->>'website')
      and (evidence.retention_until is null or evidence.retention_until > now())
  ) then v_import_website := v_snapshot->>'website'; end if;

  if v_import_phone is null and v_import_email is null and v_import_website is null then
    raise exception using errcode = '55000', message = 'Candidate lacks a permanent matching contact for this run';
  end if;

  if nullif(trim(v_snapshot->>'rut'), '') is not null and exists (
    select 1 from public.prospect_source_records evidence
    where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
      and evidence.provider in ('brave_search','official_website') and evidence.field_name = 'rut'
      and public.normalize_prospect_rut(evidence.field_value) = public.normalize_prospect_rut(v_snapshot->>'rut')
      and (evidence.retention_until is null or evidence.retention_until > now())
  ) then v_import_rut := v_snapshot->>'rut'; end if;

  if nullif(trim(v_snapshot->>'trade_name'), '') is not null and exists (
    select 1 from public.prospect_source_records evidence
    where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
      and evidence.provider in ('brave_search','official_website') and evidence.field_name = 'trade_name'
      and public.normalize_prospect_text(evidence.field_value) = public.normalize_prospect_text(v_snapshot->>'trade_name')
      and (evidence.retention_until is null or evidence.retention_until > now())
  ) then v_import_legal_name := v_snapshot->>'trade_name'; end if;

  if nullif(trim(v_snapshot->>'description'), '') is not null and exists (
    select 1 from public.prospect_source_records evidence
    where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
      and evidence.provider in ('brave_search','official_website') and evidence.field_name = 'description'
      and public.normalize_prospect_text(evidence.field_value) = public.normalize_prospect_text(v_snapshot->>'description')
      and (evidence.retention_until is null or evidence.retention_until > now())
  ) then v_import_description := v_snapshot->>'description'; end if;

  if nullif(trim(v_snapshot_location->>'address'), '') is not null and exists (
    select 1 from public.prospect_source_records evidence
    where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
      and evidence.provider in ('brave_search','official_website')
      and evidence.field_name ~ '(^|\.)address$'
      and public.normalize_prospect_address(evidence.field_value) = public.normalize_prospect_address(v_snapshot_location->>'address')
      and (evidence.retention_until is null or evidence.retention_until > now())
  ) then v_import_address := v_snapshot_location->>'address'; end if;

  if (
    select count(*) from jsonb_array_elements(v_snapshot_locations) snapshot_location
    where snapshot_location->>'comuna_code' = v_location.comuna_code
  ) > 1 and v_import_address is null then
    raise exception using errcode = '55000', message = 'Multiple locations in one commune require a permanently evidenced address';
  end if;

  select reviewed.company_id into v_existing_entity_company_id
  from public.prospecting_campaign_candidates reviewed
  where reviewed.entity_id = v_entity.id
    and reviewed.id <> v_candidate.id
    and reviewed.review_status in ('approved','linked')
    and reviewed.company_id is not null
  order by reviewed.reviewed_at
  limit 1;

  select coalesce(array_agg(distinct matches.company_id), '{}'::uuid[])
  into v_exact_company_ids
  from (
    select company.id company_id from public.companies company
    where public.normalize_prospect_rut(v_import_rut) is not null
      and public.normalize_prospect_rut(company.rut) = public.normalize_prospect_rut(v_import_rut)
    union all
    select company.id from public.companies company
    where public.normalize_prospect_domain(v_import_website) is not null
      and public.normalize_prospect_domain(company.website) = public.normalize_prospect_domain(v_import_website)
    union all
    select company.id from public.companies company
    where public.normalize_prospect_phone(v_import_phone) is not null
      and (public.normalize_prospect_phone(company.phone) = public.normalize_prospect_phone(v_import_phone)
           or public.normalize_prospect_phone(company.whatsapp) = public.normalize_prospect_phone(v_import_phone))
    union all
    select company.id
    from public.companies company
    left join public.company_locations location on location.company_id = company.id
    where public.normalize_prospect_name(company.name) = public.normalize_prospect_name(v_import_name)
      and coalesce(location.comuna_code, company.comuna_code) = v_location.comuna_code
      and ((v_import_address is null
            and public.normalize_prospect_address(coalesce(location.address, company.address)) is null)
           or public.normalize_prospect_address(coalesce(location.address, company.address))
              = public.normalize_prospect_address(v_import_address))
  ) matches;

  if p_action = 'approve' and exists (
    select 1
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_snapshot->'review_flags') = 'array'
           then v_snapshot->'review_flags' else '[]'::jsonb end
    ) flag
    where flag in ('conflicting_exact_identifiers','conflicting_exact_company_identifiers')
  ) then
    raise exception using errcode = '55000',
      message = 'Conflicting exact identifiers require an explicit link or rejection';
  end if;

  if p_action = 'link' then
    if p_company_id is null or not exists (select 1 from public.companies where id = p_company_id) then
      raise exception using errcode = '22023', message = 'link requires an existing company_id';
    end if;
    if v_existing_entity_company_id is not null
       and v_existing_entity_company_id <> p_company_id then
      raise exception using errcode = '55000', message = 'Prospect entity is already linked to a different company';
    end if;
    v_company_id := p_company_id;
    if cardinality(v_exact_company_ids) > 1 or exists (
      select 1
      from jsonb_array_elements_text(
        case when jsonb_typeof(v_snapshot->'review_flags') = 'array'
             then v_snapshot->'review_flags' else '[]'::jsonb end
      ) flag
      where flag in ('conflicting_exact_identifiers','conflicting_exact_company_identifiers')
    ) then
      -- La decision manual resuelve a que empresa pertenece la sede, pero no
      -- autoriza copiar hacia ella los identificadores/contactos contradictorios.
      v_import_rut := null;
      v_import_phone := null;
      v_import_email := null;
      v_import_website := null;
    end if;
  else
    -- Un approve nunca decide entre identidades exactas contradictorias. El
    -- revisor debe usar link con una empresa explicita (o rechazar).
    if cardinality(v_exact_company_ids) > 1 then
      raise exception using errcode = '55000',
        message = 'Conflicting exact company identifiers require an explicit link decision';
    end if;
    if v_existing_entity_company_id is not null
       and cardinality(v_exact_company_ids) = 1
       and v_exact_company_ids[1] <> v_existing_entity_company_id then
      raise exception using errcode = '55000',
        message = 'Prospect entity and exact company identity disagree; use link or reject';
    end if;

    v_company_id := coalesce(v_existing_entity_company_id, v_exact_company_ids[1]);
    v_rut_normalized := public.normalize_prospect_rut(v_import_rut);
    v_domain_normalized := public.normalize_prospect_domain(v_import_website);
    v_phone_normalized := public.normalize_prospect_phone(v_import_phone);
  end if;

  select string_agg(distinct provider, ', ' order by provider) into v_source
  from public.prospect_source_records
  where run_id = v_candidate.run_id and entity_id = v_entity.id
    and provider in ('brave_search','official_website')
    and (retention_until is null or retention_until > now());

  v_company_type := case
    when v_import_business_line in ('distribuidor','tienda comercial','tecnico','instalador grande','competencia','otro')
      then v_import_business_line::public.company_type
    else 'otro'::public.company_type
  end;

  if v_company_id is null then
    insert into public.companies (
      name, legal_name, rut, business_line, type, city, region, address,
      region_code, comuna_code, website, phone, email, source, notes, status
    ) values (
      v_import_name, v_import_legal_name, v_import_rut, v_import_business_line,
      v_company_type, v_comuna_name, v_region_name, v_import_address,
      v_location.region_code, v_location.comuna_code, v_import_website,
      v_import_phone, v_import_email, v_source,
      concat_ws(E'\n', 'Importada desde prospeccion CRM.', nullif(trim(p_notes),'')),
      'prospecto'
    ) returning id into v_company_id;
    v_created_company := true;
  else
    update public.companies
    set region_code = coalesce(nullif(trim(region_code), ''), v_location.region_code),
        comuna_code = coalesce(nullif(trim(comuna_code), ''), v_location.comuna_code),
        region = coalesce(nullif(trim(region), ''), v_region_name),
        city = coalesce(nullif(trim(city), ''), v_comuna_name),
        address = coalesce(nullif(trim(address), ''), v_import_address),
        website = coalesce(nullif(trim(website), ''), v_import_website),
        phone = coalesce(nullif(trim(phone), ''), v_import_phone),
        email = coalesce(nullif(trim(email), ''), v_import_email)
    where id = v_company_id;
  end if;

  -- Materializar todas las sedes conocidas de la entidad. La restriccion por
  -- source_prospect_location_id vuelve la operacion repetible sin duplicados.
  for v_each_location in
    select location.* from public.prospect_locations location
    where location.entity_id = v_entity.id
      and exists (
        select 1 from jsonb_array_elements(v_snapshot_locations) snapshot_location
        where snapshot_location->>'region_code' = location.region_code
          and snapshot_location->>'comuna_code' = location.comuna_code
          and coalesce(public.normalize_prospect_address(snapshot_location->>'address'), '')
              = coalesce(location.address_normalized, '')
      )
      and exists (
        select 1 from public.prospect_source_records evidence
        where evidence.run_id = v_candidate.run_id
          and evidence.entity_id = v_entity.id
          and evidence.location_id = location.id
          and evidence.provider in ('brave_search','official_website')
          and (
            (evidence.field_name ~ 'comuna_code$' and trim(evidence.field_value) = location.comuna_code)
            or (evidence.field_name ~ 'comuna_name$' and exists (
              select 1 from public.geo_comunas comuna
              where comuna.code = location.comuna_code
                and public.normalize_prospect_text(evidence.field_value) = public.normalize_prospect_text(comuna.name)
            ))
          )
          and (evidence.retention_until is null or evidence.retention_until > now())
      )
      and (
        (select count(*) from jsonb_array_elements(v_snapshot_locations) same_comuna
         where same_comuna->>'comuna_code' = location.comuna_code) <= 1
        or (
          location.address_normalized is not null
          and exists (
            select 1 from public.prospect_source_records address_evidence
            where address_evidence.run_id = v_candidate.run_id
              and address_evidence.entity_id = v_entity.id
              and address_evidence.location_id = location.id
              and address_evidence.provider in ('brave_search','official_website')
              and address_evidence.field_name ~ '(^|\.)address$'
              and public.normalize_prospect_address(address_evidence.field_value) = location.address_normalized
              and (address_evidence.retention_until is null or address_evidence.retention_until > now())
          )
        )
      )
    order by location.is_primary desc, location.created_at
  loop
    v_each_import_address := case when exists (
      select 1 from public.prospect_source_records evidence
      where evidence.run_id = v_candidate.run_id and evidence.entity_id = v_entity.id
        and evidence.location_id = v_each_location.id
        and evidence.provider in ('brave_search','official_website')
        and evidence.field_name ~ '(^|\.)address$'
        and public.normalize_prospect_address(evidence.field_value) = v_each_location.address_normalized
        and (evidence.retention_until is null or evidence.retention_until > now())
    ) then v_each_location.address else null end;

    v_company_location_id := null;
    select company_location.id into v_company_location_id
    from public.company_locations company_location
    where company_location.company_id = v_company_id
      and (
        company_location.source_prospect_location_id = v_each_location.id
        or (
          company_location.comuna_code = v_each_location.comuna_code
          and (
            (public.normalize_prospect_address(company_location.address) is null
             and public.normalize_prospect_address(v_each_import_address) is null)
            or public.normalize_prospect_address(company_location.address)
               = public.normalize_prospect_address(v_each_import_address)
          )
        )
      )
    order by case when company_location.source_prospect_location_id = v_each_location.id then 0 else 1 end,
             company_location.created_at
    limit 1
    for update;

    if v_company_location_id is null then
      insert into public.company_locations (
        company_id, source_prospect_location_id, kind, region_code, comuna_code,
        address, latitude, longitude, phone, email, is_primary
      ) values (
        v_company_id, v_each_location.id,
        case when not exists (select 1 from public.company_locations where company_id = v_company_id)
             then 'headquarters' else 'branch' end,
        v_each_location.region_code, v_each_location.comuna_code,
        v_each_import_address,
        null, null,
        v_import_phone, v_import_email,
        not exists (select 1 from public.company_locations where company_id = v_company_id)
      ) returning id into v_company_location_id;
    else
      update public.company_locations
      set source_prospect_location_id = coalesce(source_prospect_location_id, v_each_location.id),
          region_code = coalesce(region_code, v_each_location.region_code),
          comuna_code = coalesce(comuna_code, v_each_location.comuna_code),
          address = coalesce(address, v_each_import_address),
          phone = coalesce(phone, v_import_phone),
          email = coalesce(email, v_import_email),
          updated_at = now()
      where id = v_company_location_id;
    end if;
  end loop;

  v_review_status := case when v_created_company then 'approved' else 'linked' end;
  update public.prospecting_campaign_candidates
  set review_status = v_review_status,
      company_id = v_company_id,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_notes = nullif(trim(p_notes),'')
  where id = p_candidate_id;

  insert into public.activity_logs (actor_id, entity_type, entity_id, action, metadata)
  values (
    auth.uid(), 'prospecting_candidate', p_candidate_id,
    case when v_created_company then 'prospect_approved' else 'prospect_linked' end,
    jsonb_build_object('company_id', v_company_id, 'run_id', v_candidate.run_id)
  );

  return jsonb_build_object(
    'candidate_id', p_candidate_id,
    'review_status', v_review_status,
    'company_id', v_company_id,
    'created_company', v_created_company,
    'company_location_id', v_company_location_id
  );
end;
$$;

create or replace function public.approve_or_link_prospect_candidate(
  p_candidate_id uuid,
  p_company_id uuid default null,
  p_notes text default null
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.review_prospect_candidate(
    p_candidate_id,
    case when p_company_id is null then 'approve' else 'link' end,
    p_company_id,
    p_notes
  )
$$;

create or replace view public.active_prospect_source_records
with (security_invoker = true)
as
select *, retention_until is not null as has_expiration
from public.prospect_source_records
where retention_until is null or retention_until > now();

-- ---------------------------------------------------------------------------
-- RLS: el frontend lee; las mutaciones sensibles pasan por RPC.
-- ---------------------------------------------------------------------------

alter table public.geo_regions enable row level security;
alter table public.geo_comunas enable row level security;
alter table public.prospecting_campaigns enable row level security;
alter table public.prospecting_runs enable row level security;
alter table public.prospecting_tasks enable row level security;
alter table public.prospect_entities enable row level security;
alter table public.prospect_locations enable row level security;
alter table public.prospecting_campaign_candidates enable row level security;
alter table public.prospect_source_records enable row level security;
alter table public.prospecting_events enable row level security;
alter table public.company_locations enable row level security;
alter table public.prospecting_api_idempotency enable row level security;
alter table public.prospecting_retention_audits enable row level security;

drop policy if exists "authenticated read geo regions" on public.geo_regions;
create policy "authenticated read geo regions" on public.geo_regions for select to authenticated using (true);
drop policy if exists "authenticated read geo comunas" on public.geo_comunas;
create policy "authenticated read geo comunas" on public.geo_comunas for select to authenticated using (true);

drop policy if exists "authenticated read prospecting campaigns" on public.prospecting_campaigns;
create policy "authenticated read prospecting campaigns" on public.prospecting_campaigns for select to authenticated using (true);
drop policy if exists "admins manage prospecting campaigns" on public.prospecting_campaigns;
create policy "admins manage prospecting campaigns" on public.prospecting_campaigns for all to authenticated
using (public.current_role() = 'administrador') with check (public.current_role() = 'administrador');
drop policy if exists "sellers create prospecting drafts" on public.prospecting_campaigns;
create policy "sellers create prospecting drafts" on public.prospecting_campaigns for insert to authenticated
with check (public.current_role() = 'vendedor' and status = 'draft' and created_by = auth.uid());
drop policy if exists "sellers update prospecting drafts" on public.prospecting_campaigns;
create policy "sellers update prospecting drafts" on public.prospecting_campaigns for update to authenticated
using (public.current_role() = 'vendedor' and status = 'draft')
with check (public.current_role() = 'vendedor' and status = 'draft');

drop policy if exists "authenticated read prospecting runs" on public.prospecting_runs;
create policy "authenticated read prospecting runs" on public.prospecting_runs for select to authenticated using (true);
drop policy if exists "authenticated read prospecting tasks" on public.prospecting_tasks;
create policy "authenticated read prospecting tasks" on public.prospecting_tasks for select to authenticated using (true);
drop policy if exists "authenticated read prospect entities" on public.prospect_entities;
create policy "authenticated read prospect entities" on public.prospect_entities for select to authenticated using (true);
drop policy if exists "authenticated read prospect locations" on public.prospect_locations;
create policy "authenticated read prospect locations" on public.prospect_locations for select to authenticated using (true);
drop policy if exists "authenticated read prospect candidates" on public.prospecting_campaign_candidates;
create policy "authenticated read prospect candidates" on public.prospecting_campaign_candidates for select to authenticated using (true);
drop policy if exists "authenticated read prospect evidence" on public.prospect_source_records;
create policy "authenticated read prospect evidence" on public.prospect_source_records for select to authenticated using (true);
drop policy if exists "authenticated read prospecting events" on public.prospecting_events;
create policy "authenticated read prospecting events" on public.prospecting_events for select to authenticated using (true);
drop policy if exists "authenticated read company locations" on public.company_locations;
create policy "authenticated read company locations" on public.company_locations for select to authenticated using (true);
drop policy if exists "admins read prospecting retention audits" on public.prospecting_retention_audits;
create policy "admins read prospecting retention audits" on public.prospecting_retention_audits
for select to authenticated using (public.current_role() = 'administrador');

revoke all on table public.prospecting_api_idempotency from anon, authenticated;
grant select on public.geo_regions, public.geo_comunas,
  public.prospecting_campaigns, public.prospecting_runs, public.prospecting_tasks,
  public.prospect_entities, public.prospect_locations,
  public.prospecting_campaign_candidates, public.prospect_source_records,
  public.active_prospect_source_records, public.prospecting_events,
  public.company_locations, public.prospecting_retention_audits to authenticated;
grant insert, update on public.prospecting_campaigns to authenticated;
grant select, insert, update, delete on public.geo_regions, public.geo_comunas,
  public.prospecting_campaigns, public.prospecting_runs, public.prospecting_tasks,
  public.prospect_entities, public.prospect_locations,
  public.prospecting_campaign_candidates, public.prospect_source_records,
  public.prospecting_events, public.company_locations,
  public.prospecting_api_idempotency, public.prospecting_retention_audits to service_role;
grant select on public.active_prospect_source_records to service_role;

revoke all on function public.prospecting_require_roles(text[]) from public;
revoke all on function public.prospecting_begin_idempotent_request(uuid,text,text,text) from public;
revoke all on function public.prospecting_finish_idempotent_request(uuid,text,text,text,integer,jsonb) from public;
revoke all on function public.prospecting_release_idempotent_request(uuid,text,text,text) from public;
revoke all on function public.purge_expired_prospect_source_records() from public;
revoke all on function public.enqueue_prospecting_run(uuid,uuid) from public;
revoke all on function public.claim_prospecting_run(uuid,text,integer) from public;
revoke all on function public.heartbeat_prospecting_run(uuid,uuid,text,uuid,integer) from public;
revoke all on function public.request_prospecting_run_cancel(uuid) from public;
revoke all on function public.append_prospecting_events(uuid,uuid,text,uuid,jsonb) from public;
revoke all on function public.upsert_prospect_candidates(uuid,uuid,text,uuid,jsonb) from public;
revoke all on function public.complete_prospecting_run(uuid,uuid,text,uuid,text,jsonb) from public;
revoke all on function public.fail_prospecting_run(uuid,uuid,text,uuid,text) from public;
revoke all on function public.review_prospect_candidate(uuid,text,uuid,text) from public;
revoke all on function public.approve_or_link_prospect_candidate(uuid,uuid,text) from public;

grant execute on function public.enqueue_prospecting_run(uuid,uuid) to authenticated;
grant execute on function public.request_prospecting_run_cancel(uuid) to authenticated;
grant execute on function public.review_prospect_candidate(uuid,text,uuid,text) to authenticated;
grant execute on function public.approve_or_link_prospect_candidate(uuid,uuid,text) to authenticated;
grant execute on function public.purge_expired_prospect_source_records() to authenticated;

grant execute on function public.prospecting_begin_idempotent_request(uuid,text,text,text) to service_role;
grant execute on function public.prospecting_finish_idempotent_request(uuid,text,text,text,integer,jsonb) to service_role;
grant execute on function public.prospecting_release_idempotent_request(uuid,text,text,text) to service_role;
grant execute on function public.purge_expired_prospect_source_records() to service_role;
grant execute on function public.claim_prospecting_run(uuid,text,integer) to service_role;
grant execute on function public.heartbeat_prospecting_run(uuid,uuid,text,uuid,integer) to service_role;
grant execute on function public.append_prospecting_events(uuid,uuid,text,uuid,jsonb) to service_role;
grant execute on function public.upsert_prospect_candidates(uuid,uuid,text,uuid,jsonb) to service_role;
grant execute on function public.complete_prospecting_run(uuid,uuid,text,uuid,text,jsonb) to service_role;
grant execute on function public.fail_prospecting_run(uuid,uuid,text,uuid,text) to service_role;

comment on table public.prospecting_campaigns is 'Definiciones reutilizables de busquedas; no son campanas de mensajeria.';
comment on table public.prospecting_runs is 'Ejecuciones inmutables reclamadas por un worker mediante lease.';
comment on table public.prospecting_campaign_candidates is 'Bandeja CRM; solo review_prospect_candidate crea o vincula empresas.';
comment on table public.prospect_source_records is 'Evidencia por campo; no almacenar respuestas crudas de proveedores.';

-- ---------------------------------------------------------------------------
-- Base historica: staging confiable como relacion pasada, no como contacto actual.
-- ---------------------------------------------------------------------------

create table if not exists public.historical_import_batches (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'processing'
    check (status in ('processing','ready','partial','failed','rolled_back')),
  relationship_date date,
  authorization_confirmed boolean not null default false,
  source_row_count integer not null default 0 check (source_row_count >= 0),
  entity_count integer not null default 0 check (entity_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  needs_review_count integer not null default 0 check (needs_review_count >= 0),
  sheet_names text[] not null default '{}',
  stats jsonb not null default '{}',
  error_message text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  rolled_back_at timestamptz
);

create index if not exists historical_import_batches_sha_idx
  on public.historical_import_batches (file_sha256, created_at desc);

create table if not exists public.historical_entities (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null unique,
  legacy_code text,
  legal_name text not null,
  name_normalized text generated always as (public.normalize_prospect_name(legal_name)) stored,
  rut_raw text,
  rut_normalized text,
  rut_valid boolean not null default false,
  relationship_date date,
  territory_status text not null default 'unknown'
    check (territory_status in ('unknown','verified','conflict')),
  region_code text references public.geo_regions(code),
  comuna_code text references public.geo_comunas(code),
  verification_status text not null default 'historical_unverified'
    check (verification_status in ('historical_unverified','enrichment_pending','verified','not_found','needs_review')),
  flags text[] not null default '{}',
  provenance jsonb not null default '[]',
  last_enriched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (rut_normalized is null or rut_normalized = public.normalize_prospect_rut(rut_normalized))
);

create index if not exists historical_entities_rut_idx on public.historical_entities (rut_normalized)
  where rut_normalized is not null;
create index if not exists historical_entities_name_idx on public.historical_entities (name_normalized);

create table if not exists public.historical_contact_points (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.historical_entities(id) on delete cascade,
  kind text not null check (kind in ('email','phone')),
  raw_value text not null,
  normalized_value text,
  validation_status text not null
    check (validation_status in ('valid','invalid','ambiguous','unverified')),
  is_current boolean,
  first_seen_at date,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (entity_id, kind, raw_value)
);

create table if not exists public.historical_import_batch_entities (
  batch_id uuid not null references public.historical_import_batches(id) on delete cascade,
  entity_id uuid not null references public.historical_entities(id) on delete cascade,
  source_rows integer not null default 1 check (source_rows > 0),
  provenance jsonb not null default '[]',
  primary key (batch_id, entity_id)
);

create table if not exists public.historical_matches (
  id uuid primary key default gen_random_uuid(),
  historical_entity_id uuid not null references public.historical_entities(id) on delete cascade,
  prospect_entity_id uuid references public.prospect_entities(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  match_type text not null check (match_type in ('rut','domain','phone','name_territory','fuzzy')),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  status text not null default 'suggested' check (status in ('suggested','confirmed','rejected')),
  evidence jsonb not null default '{}',
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (prospect_entity_id is not null or company_id is not null)
);

create unique index if not exists historical_matches_prospect_unique
  on public.historical_matches (historical_entity_id, prospect_entity_id) where prospect_entity_id is not null;
create unique index if not exists historical_matches_company_unique
  on public.historical_matches (historical_entity_id, company_id) where company_id is not null;

create or replace function public.create_historical_import_batch(
  p_filename text,
  p_file_sha256 text,
  p_relationship_date date,
  p_source_row_count integer,
  p_sheet_names text[],
  p_authorization_confirmed boolean
) returns public.historical_import_batches
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_batch public.historical_import_batches;
begin
  perform public.prospecting_require_roles(array['administrador','vendedor']);
  if not p_authorization_confirmed then
    raise exception 'Debes confirmar que la base puede ser usada comercialmente.' using errcode = '22023';
  end if;
  if p_file_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Hash SHA-256 invalido.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_file_sha256, 0));
  select * into v_batch from public.historical_import_batches
    where file_sha256 = p_file_sha256 and status <> 'rolled_back'
    order by created_at desc limit 1;
  if found then return v_batch; end if;
  insert into public.historical_import_batches (
    filename, file_sha256, relationship_date, source_row_count, sheet_names,
    authorization_confirmed, created_by
  ) values (
    left(trim(p_filename), 255), p_file_sha256, p_relationship_date,
    greatest(coalesce(p_source_row_count, 0), 0), coalesce(p_sheet_names, '{}'), true, auth.uid()
  ) returning * into v_batch;
  return v_batch;
end $$;

create or replace function public.upsert_historical_import_rows(p_batch_id uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch public.historical_import_batches;
  v_row jsonb;
  v_entity_id uuid;
  v_email text;
  v_count integer := 0;
begin
  perform public.prospecting_require_roles(array['administrador','vendedor']);
  select * into v_batch from public.historical_import_batches where id = p_batch_id for update;
  if not found or v_batch.status <> 'processing' then
    raise exception 'Lote historico inexistente o cerrado.' using errcode = '22023';
  end if;
  if public.current_role() <> 'administrador' and v_batch.created_by <> auth.uid() then
    raise exception 'No puedes modificar este lote.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'Cada lote debe contener entre 0 y 500 filas.' using errcode = '22023';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    if nullif(trim(v_row->>'identity_key'),'') is null or nullif(trim(v_row->>'legal_name'),'') is null then
      raise exception 'identity_key y legal_name son obligatorios.' using errcode = '22023';
    end if;
    insert into public.historical_entities (
      identity_key, legacy_code, legal_name, rut_raw, rut_normalized, rut_valid,
      relationship_date, flags, provenance
    ) values (
      left(v_row->>'identity_key', 500), nullif(trim(v_row->>'legacy_code'),''), trim(v_row->>'legal_name'),
      nullif(trim(v_row->>'rut_raw'),''), nullif(trim(v_row->>'rut_normalized'),''),
      coalesce((v_row->>'rut_valid')::boolean, false), v_batch.relationship_date,
      coalesce(array(select jsonb_array_elements_text(v_row->'flags')), '{}'),
      coalesce(v_row->'provenance', '[]')
    ) on conflict (identity_key) do update set
      legacy_code = coalesce(public.historical_entities.legacy_code, excluded.legacy_code),
      rut_raw = coalesce(public.historical_entities.rut_raw, excluded.rut_raw),
      rut_normalized = coalesce(public.historical_entities.rut_normalized, excluded.rut_normalized),
      rut_valid = public.historical_entities.rut_valid or excluded.rut_valid,
      relationship_date = coalesce(public.historical_entities.relationship_date, excluded.relationship_date),
      flags = array(select distinct unnest(public.historical_entities.flags || excluded.flags)),
      provenance = public.historical_entities.provenance || excluded.provenance,
      updated_at = now()
    returning id into v_entity_id;

    insert into public.historical_import_batch_entities (batch_id, entity_id, source_rows, provenance)
    values (p_batch_id, v_entity_id, greatest(jsonb_array_length(coalesce(v_row->'provenance','[]')),1), coalesce(v_row->'provenance','[]'))
    on conflict (batch_id, entity_id) do update set
      source_rows = excluded.source_rows, provenance = excluded.provenance;

    for v_email in select jsonb_array_elements_text(coalesce(v_row->'emails','[]')) loop
      insert into public.historical_contact_points (entity_id, kind, raw_value, normalized_value, validation_status, first_seen_at)
      values (v_entity_id, 'email', v_email, lower(v_email), 'valid', v_batch.relationship_date)
      on conflict (entity_id, kind, raw_value) do nothing;
    end loop;
    if nullif(trim(v_row->>'phone_raw'),'') is not null then
      insert into public.historical_contact_points (entity_id, kind, raw_value, normalized_value, validation_status, first_seen_at)
      values (
        v_entity_id, 'phone', trim(v_row->>'phone_raw'), nullif(trim(v_row->>'phone_normalized'),''),
        case when nullif(trim(v_row->>'phone_normalized'),'') is null then 'ambiguous' else 'valid' end,
        v_batch.relationship_date
      ) on conflict (entity_id, kind, raw_value) do nothing;
    end if;
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('batch_id', p_batch_id, 'accepted', v_count);
end $$;

create or replace function public.complete_historical_import_batch(p_batch_id uuid, p_stats jsonb)
returns public.historical_import_batches language plpgsql security definer set search_path = public, pg_temp as $$
declare v_batch public.historical_import_batches;
begin
  perform public.prospecting_require_roles(array['administrador','vendedor']);
  update public.historical_import_batches set
    status = case when coalesce((p_stats->>'needs_review')::integer,0) > 0 then 'partial' else 'ready' end,
    entity_count = (select count(*) from public.historical_import_batch_entities where batch_id = p_batch_id),
    duplicate_count = greatest(coalesce((p_stats->>'duplicates_consolidated')::integer,0),0),
    needs_review_count = greatest(coalesce((p_stats->>'needs_review')::integer,0),0),
    stats = coalesce(p_stats,'{}'), completed_at = now()
  where id = p_batch_id and status = 'processing'
    and (created_by = auth.uid() or public.current_role() = 'administrador')
  returning * into v_batch;
  if not found then raise exception 'No fue posible cerrar el lote.' using errcode = '22023'; end if;
  return v_batch;
end $$;

create or replace function public.rollback_historical_import_batch(p_batch_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_removed integer;
begin
  perform public.prospecting_require_roles(array['administrador']);
  update public.historical_import_batches set status = 'rolled_back', rolled_back_at = now()
    where id = p_batch_id and status <> 'rolled_back';
  if not found then return jsonb_build_object('batch_id',p_batch_id,'rolled_back',false); end if;
  delete from public.historical_import_batch_entities where batch_id = p_batch_id;
  delete from public.historical_entities entity where not exists (
    select 1 from public.historical_import_batch_entities link where link.entity_id = entity.id
  );
  get diagnostics v_removed = row_count;
  return jsonb_build_object('batch_id',p_batch_id,'rolled_back',true,'orphan_entities_removed',v_removed);
end $$;

alter table public.historical_import_batches enable row level security;
alter table public.historical_entities enable row level security;
alter table public.historical_contact_points enable row level security;
alter table public.historical_import_batch_entities enable row level security;
alter table public.historical_matches enable row level security;

drop policy if exists "authenticated read historical batches" on public.historical_import_batches;
create policy "authenticated read historical batches" on public.historical_import_batches for select to authenticated using (true);
drop policy if exists "authenticated read historical entities" on public.historical_entities;
create policy "authenticated read historical entities" on public.historical_entities for select to authenticated using (true);
drop policy if exists "authenticated read historical contacts" on public.historical_contact_points;
create policy "authenticated read historical contacts" on public.historical_contact_points for select to authenticated using (true);
drop policy if exists "authenticated read historical batch links" on public.historical_import_batch_entities;
create policy "authenticated read historical batch links" on public.historical_import_batch_entities for select to authenticated using (true);
drop policy if exists "authenticated read historical matches" on public.historical_matches;
create policy "authenticated read historical matches" on public.historical_matches for select to authenticated using (true);

grant select on public.historical_import_batches, public.historical_entities,
  public.historical_contact_points, public.historical_import_batch_entities,
  public.historical_matches to authenticated;
grant select, insert, update, delete on public.historical_import_batches, public.historical_entities,
  public.historical_contact_points, public.historical_import_batch_entities,
  public.historical_matches to service_role;
revoke all on function public.create_historical_import_batch(text,text,date,integer,text[],boolean) from public;
revoke all on function public.upsert_historical_import_rows(uuid,jsonb) from public;
revoke all on function public.complete_historical_import_batch(uuid,jsonb) from public;
revoke all on function public.rollback_historical_import_batch(uuid) from public;
grant execute on function public.create_historical_import_batch(text,text,date,integer,text[],boolean) to authenticated;
grant execute on function public.upsert_historical_import_rows(uuid,jsonb) to authenticated;
grant execute on function public.complete_historical_import_batch(uuid,jsonb) to authenticated;
grant execute on function public.rollback_historical_import_batch(uuid) to authenticated;
grant execute on function public.create_historical_import_batch(text,text,date,integer,text[],boolean) to service_role;
grant execute on function public.upsert_historical_import_rows(uuid,jsonb) to service_role;
grant execute on function public.complete_historical_import_batch(uuid,jsonb) to service_role;
grant execute on function public.rollback_historical_import_batch(uuid) to service_role;

comment on table public.historical_entities is 'Base histórica separada: prueba relación pasada, no vigencia actual ni consentimiento de contacto.';
comment on table public.historical_matches is 'Coincidencias sugeridas con candidatos o empresas; nunca crea destinatarios automáticamente.';
