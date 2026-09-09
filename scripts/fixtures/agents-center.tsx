import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { AgentsDashboard, type AgentCenterData } from '../../src/modules/agents/AgentsDashboard';
import { agentDefinitions } from '../../src/modules/agents/agent-center';
import '../../src/styles.css';
const now = new Date().toISOString();
const tasks = agentDefinitions.map((a, i) => ({ id: a.type, agent_type: a.type, action: a.action, status: i === 4 ? 'failed' : 'completed', created_at: now, result: { metrics: { [a.metric]: ['operating_profit','receivables'].includes(a.metric) ? 11465745 : 7 } } }));
const data: AgentCenterData = { tasks, activity: tasks, schedule: { morning_time:'12:00:00',timezone:'America/Santiago',email_enabled:true }, delivery:{status:'sent',sent_at:now,created_at:now,error:null},
  proposals: [{id:'p1',kind:'campaign_draft',title:'Revisar contenido de productos Super Stars',summary:'Borrador basado en productos disponibles. Pendiente de revision comercial.',risk_level:'high',status:'pending',created_at:now}],
  actions:[{id:'a1',kind:'executive_alert',title:'Supervisar la operacion de importacion',destination_module:'executive',destination_path:'/agentes/executive/dashboard',destination_record_id:'record',summary:null,status:'pending',created_at:now}],alerts:[],
  connections:[{provider:'facto',status:'connected',message:'Conexion de solo lectura',last_success_at:now},{provider:'tiendanube',status:'degraded',message:'Sincronizacion pendiente',last_success_at:null}],totals:{proposals:1,actions:1,alerts:0} };
function Fixture() {
  const [action,setAction] = useState(''); const location=useLocation();
  return <main className="fixture-frame"><AgentsDashboard data={data} loading={false} busy="" notice="" canManage={!location.search.includes('readonly')} refresh={()=>setAction('refresh')} request={t=>setAction(`request:${t}`)} decide={(id,d)=>setAction(`${id}:${d}`)} more={()=>setAction('more')} /><output aria-label="Resultado de prueba">{action}</output><output aria-label="Ruta de prueba">{location.pathname}</output></main>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Fixture /></BrowserRouter>);
