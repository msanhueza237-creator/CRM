import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Filter, Plus, Search } from "lucide-react";
import { useCompanyStore } from "./CompanyStore";
import type { CompanyStatus, CompanyType, Priority } from "../../types/crm";
import { chileData, normalizeString } from "../../data/chileData";

const allTypes = ["todos", "distribuidor", "tienda comercial", "tecnico", "instalador grande", "competencia", "otro"] as const;
const allStatuses = ["todos", "prospecto", "contactado", "interesado", "cotizado", "cliente", "descartado"] as const;
const allPriorities = ["todos", "alta", "media", "baja"] as const;

export function CompaniesPage() {
  const { companies: storedCompanies } = useCompanyStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialType = allTypes.includes(searchParams.get("type") as (typeof allTypes)[number])
    ? (searchParams.get("type") as (typeof allTypes)[number])
    : "todos";
  const initialStatus = allStatuses.includes(searchParams.get("status") as (typeof allStatuses)[number])
    ? (searchParams.get("status") as (typeof allStatuses)[number])
    : "todos";
  const initialPriority = allPriorities.includes(searchParams.get("priority") as (typeof allPriorities)[number])
    ? (searchParams.get("priority") as (typeof allPriorities)[number])
    : "todos";
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [type, setType] = useState<(typeof allTypes)[number]>(initialType);
  const [status, setStatus] = useState<(typeof allStatuses)[number]>(initialStatus);
  const [priority, setPriority] = useState<(typeof allPriorities)[number]>(initialPriority);
  const [regionFilter, setRegionFilter] = useState<string>(searchParams.get("region") ?? "todos");
  const [cityFilter, setCityFilter] = useState<string>(searchParams.get("city") ?? "todos");
  const [sourceFilter, setSourceFilter] = useState<string>(searchParams.get("source") ?? "");

  function updateFilters(nextFilters: {
    query?: string;
    type?: (typeof allTypes)[number];
    status?: (typeof allStatuses)[number];
    priority?: (typeof allPriorities)[number];
    region?: string;
    city?: string;
    source?: string;
  }) {
    const nextQuery = nextFilters.query ?? query;
    const nextType = nextFilters.type ?? type;
    const nextStatus = nextFilters.status ?? status;
    const nextPriority = nextFilters.priority ?? priority;
    const nextRegion = nextFilters.region ?? regionFilter;
    const nextCity = nextFilters.city ?? cityFilter;
    const nextSource = nextFilters.source ?? sourceFilter;

    const params = new URLSearchParams();
    if (nextQuery) params.set("q", nextQuery);
    if (nextType !== "todos") params.set("type", nextType);
    if (nextStatus !== "todos") params.set("status", nextStatus);
    if (nextPriority !== "todos") params.set("priority", nextPriority);
    if (nextRegion !== "todos") params.set("region", nextRegion);
    if (nextCity !== "todos") params.set("city", nextCity);
    if (nextSource) params.set("source", nextSource);
    setSearchParams(params, { replace: true });
  }

  const availableCities = useMemo(() => {
    if (regionFilter === "todos") {
      return chileData.flatMap((r) => r.comunas).sort();
    }
    return chileData.find((r) => r.region === regionFilter)?.comunas.sort() ?? [];
  }, [regionFilter]);

  const companies = useMemo(() => {
    return [...storedCompanies]
      .filter((company) => {
        const searchable = [company.name, company.city, company.region, company.contactName, company.email].join(" ").toLowerCase();
        return searchable.includes(query.toLowerCase());
      })
      .filter((company) => type === "todos" || company.type === (type as CompanyType))
      .filter((company) => status === "todos" || company.status === (status as CompanyStatus))
      .filter((company) => priority === "todos" || company.priority === (priority as Priority))
      .filter((company) => {
        if (regionFilter === "todos") return true;
        return normalizeString(company.region) === normalizeString(regionFilter);
      })
      .filter((company) => {
        if (cityFilter === "todos") return true;
        return normalizeString(company.city) === normalizeString(cityFilter);
      })
      .filter((company) => {
        if (!sourceFilter) return true;
        if (sourceFilter === "Sin fuente") return !company.source?.trim();
        return normalizeString(company.source ?? "") === normalizeString(sourceFilter);
      })
      .sort((a, b) => a.nextFollowUp.localeCompare(b.nextFollowUp));
  }, [priority, query, status, storedCompanies, type, regionFilter, cityFilter, sourceFilter]);

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <p>Gestion comercial</p>
          <h1>Empresas</h1>
        </div>
        <Link className="primary-button" to="/empresas/nueva">
          <Plus size={18} />
          Crear empresa
        </Link>
      </div>

      <div className="filters-panel">
        <label className="search-field">
          <Search size={18} />
          <input
            placeholder="Buscar por empresa, ciudad, contacto o email"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              updateFilters({ query: event.target.value });
            }}
          />
        </label>
        <Select label="Tipo" value={type} onChange={(value) => { setType(value); updateFilters({ type: value }); }} options={allTypes} />
        <Select label="Estado" value={status} onChange={(value) => { setStatus(value); updateFilters({ status: value }); }} options={allStatuses} />
        <Select label="Prioridad" value={priority} onChange={(value) => { setPriority(value); updateFilters({ priority: value }); }} options={allPriorities} />
        <Select label="Región" value={regionFilter} onChange={(value) => { setRegionFilter(value); setCityFilter("todos"); updateFilters({ region: value, city: "todos" }); }} options={["todos", ...chileData.map((r) => r.region)]} />
        <Select label="Ciudad" value={cityFilter} onChange={(value) => { setCityFilter(value); updateFilters({ city: value }); }} options={["todos", ...availableCities]} />
      </div>

      {sourceFilter && (
        <p className="muted">
          Filtrando por fuente: <strong>{sourceFilter}</strong>{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => { setSourceFilter(""); updateFilters({ source: "" }); }}
          >
            Quitar filtro
          </button>
        </p>
      )}

      <div className="panel">
        <div className="panel-heading">
          <h2>Base comercial</h2>
          <span><Filter size={16} /> {companies.length} resultados</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Empresa</th>
                <th>Tipo</th>
                <th>Ciudad</th>
                <th>Contacto</th>
                <th>Estado</th>
                <th>Prioridad</th>
                <th>Seguimiento</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.id}>
                  <td>
                    <Link className="table-link" to={`/empresas/${company.id}`}>{company.name}</Link>
                    <small>{company.legalName}</small>
                  </td>
                  <td>{company.type}</td>
                  <td>{company.city}</td>
                  <td>{company.contactName}</td>
                  <td><span className={`status-badge ${company.status}`}>{company.status}</span></td>
                  <td><span className={`priority ${company.priority}`}>{company.priority}</span></td>
                  <td>{company.nextFollowUp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly T[];
}) {
  return (
    <label className="select-field">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}
