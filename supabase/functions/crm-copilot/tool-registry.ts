import {
  CopilotDataError,
  decimalSum,
  matches,
  numeric,
  object,
  observedAt,
  readResult,
  rows,
  tableResult,
  type Domain,
  type ReadResult,
  type Row,
  type ToolDefinition,
} from "./contracts.ts";
import { dateRange, inRange, todayChile } from "./dates.ts";
import { canReadDomain } from "./permissions.ts";
import { CopilotSources } from "./sources.ts";
import { findProducts, resolveProducts } from "./product-resolution.ts";
import { clientPriceRows, factoCurrencies, productPrices } from "./product-prices.ts";
import { productSales } from "./product-sales.ts";
import { agentReport, agentSectionRows } from "./agent-reports.ts";

const string = { type: ["string", "null"], maxLength: 160 };
const integer = (min: number, max: number) => ({
  type: ["integer", "null"],
  minimum: min,
  maximum: max,
});
const choice = (...values: string[]) => ({
  type: ["string", "null"],
  enum: [...values, null],
});
const paging = {
  query: {
    ...string,
    description: "Nombre, RUT, SKU o termino solicitado por el usuario (por ejemplo rejilla). Usa null solo cuando no haya un filtro de texto; no descartes un nombre mencionado.",
  },
  offset: integer(0, 10000),
  limit: integer(1, 100),
};
const period = {
  period: choice(
    "today",
    "this_week",
    "last_week",
    "this_month",
    "last_month",
    "this_year",
    "custom",
    "all",
  ),
  from: string,
  to: string,
};
const columns = (...pairs: string[]) =>
  pairs.map((pair) => {
    const [key, label] = pair.split(":");
    return { key, label };
  });
const pick = (row: Row, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, row[key] ?? null]));

export function validateArguments(schema: Row, args: unknown): Row {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new CopilotDataError("Parametros invalidos.", "INVALID_ARGUMENTS");
  const result = object(args),
    properties = object(schema.properties);
  for (const key of Object.keys(result)) {
    if (!(key in properties))
      throw new CopilotDataError(
        `Parametro no permitido: ${key}.`,
        "INVALID_ARGUMENTS",
      );
    const rule = object(properties[key]),
      value = result[key];
    if (value === null) continue;
    if (Array.isArray(rule.enum) && !rule.enum.includes(value))
      throw new CopilotDataError(
        `Opcion invalida: ${key}.`,
        "INVALID_ARGUMENTS",
      );
    const types = rule.type as string[];
    if (
      types.includes("string") &&
      (typeof value !== "string" ||
        value.length > Number(rule.maxLength || 160))
    )
      throw new CopilotDataError(
        `Texto invalido: ${key}.`,
        "INVALID_ARGUMENTS",
      );
    if (
      types.includes("integer") &&
      (!Number.isInteger(value) ||
        Number(value) < Number(rule.minimum) ||
        Number(value) > Number(rule.maximum))
    )
      throw new CopilotDataError(
        `Numero invalido: ${key}.`,
        "INVALID_ARGUMENTS",
      );
  }
  return result;
}

export function latestMetrics(data: Row[]): Row[] {
  const latest = new Map<string, Row>();
  for (const row of data) {
    const key = String(row.publication_id);
    if (
      !latest.has(key) ||
      String(row.observed_at) > String(latest.get(key)?.observed_at)
    )
      latest.set(key, row);
  }
  return [...latest.values()];
}

export class ToolRegistry {
  private definitions = new Map<string, ToolDefinition>();
  constructor(private source: CopilotSources) {
    this.registerTools();
  }
  list() {
    return [...this.definitions.values()].filter((tool) =>
      canReadDomain(this.source.actor.role, tool.domain),
    );
  }
  async execute(name: string, input: unknown): Promise<ReadResult> {
    const definition = this.definitions.get(name);
    if (!definition)
      return readResult(
        name,
        "products",
        "Herramienta no disponible.",
        null,
        [],
        { status: "unavailable" },
      );
    if (!canReadDomain(this.source.actor.role, definition.domain))
      return readResult(
        name,
        definition.domain,
        "Tu perfil no autoriza esta consulta.",
        null,
        [],
        { status: "forbidden" },
      );
    try {
      const args = validateArguments(definition.parameters, input);
      const result = await definition.execute(args);
      // Compact sales aggregates are kept complete for export; document evidence keeps the normal cap.
      const maxSize = name === "get_top_products" && args.detail_level !== "evidence" ? 900000 : 180000;
      if (JSON.stringify(result).length > maxSize)
        throw new CopilotDataError(
          "El resultado es demasiado amplio. Acota el periodo, producto o cliente para obtener una respuesta completa.",
          "COVERAGE_LIMIT",
        );
      if (
        result.coverage.nextOffset !== undefined &&
        "offset" in object(definition.parameters.properties)
      )
        result.continuation = {
          toolName: name,
          args: { ...args, offset: result.coverage.nextOffset },
        };
      const stamp = result.freshness.sourceObservedAt;
      if (stamp && Date.now() - Date.parse(stamp) > 86400000)
        result.warnings.push(
          `Fuente observada por ultima vez el ${stamp}; no equivale a una consulta en vivo al proveedor.`,
        );
      return result;
    } catch (error) {
      if (this.source.signal?.aborted) throw error;
      const known = error instanceof CopilotDataError;
      return readResult(
        name,
        definition.domain,
        known
          ? error.message
          : "No se pudo consultar la fuente. No hay datos verificados para esta respuesta.",
        null,
        [],
        {
          status:
            known && error.code === "INVALID_ARGUMENTS"
              ? "needs_clarification"
              : known && error.code === "FORBIDDEN"
                ? "forbidden"
                : "unavailable",
          coverage: { complete: false, totalMatched: null, returned: 0 },
        },
      );
    }
  }
  private add(
    name: string,
    domain: Domain,
    description: string,
    properties: Row,
    execute: ToolDefinition["execute"],
  ) {
    this.definitions.set(name, {
      name,
      domain,
      description,
      version: 1,
      execute,
      parameters: {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    });
  }
  private registerTools() {
    this.add(
      "search_prospects",
      "customers",
      "Prospectos registrados en Prospeccion, no confundir con clientes confirmados. Busqueda por nombre, RUT, rubro o categoria.",
      { ...paging, category: string },
      async (args) => {
        const data = await this.source.all(
          "prospect_entities?select=id,name,legal_name,rut,business_line,company_type,description,relevance_score,updated_at&duplicate_of_entity_id=is.null&order=id.asc",
        );
        return tableResult(
          "search_prospects",
          "customers",
          "Prospectos CRM",
          data
            .filter((d) =>
              matches(args.query, d.name, d.legal_name, d.rut, d.business_line),
            )
            .filter(
              (d) => !args.category || matches(args.category, d.company_type),
            ),
          columns(
            "name:Empresa",
            "rut:RUT",
            "company_type:Categoria",
            "business_line:Rubro",
            "relevance_score:Relevancia",
          ),
          "/prospeccion",
          args,
          [
            "Son prospectos; no se presume historial de compra ni consentimiento para mensajes.",
          ],
        );
      },
    );
    this.add(
      "get_bank_movements",
      "finance",
      "Movimientos reales de cartolas y conciliacion por fecha, nombre, RUT o referencia. Cada cuenta y moneda se mantiene separada. No registra pagos ni asientos.",
      {
        ...paging,
        ...period,
        state: choice("all", "unmatched", "partial", "matched"),
      },
      async (args) => {
        const entity = await this.source.entity(),
          range = dateRange(args);
        const accounts = await this.source.all(
          `accounting_bank_accounts?select=id,institution,account_name,currency&entity_id=eq.${entity}&order=id.asc`,
        );
        const raw = await this.source.all(
          `accounting_bank_transactions?select=id,bank_account_id,transaction_date,description,reference,amount,currency,amount_clp,reconciliation_status,updated_at&entity_id=eq.${entity}&transaction_date=gte.${range.from}&transaction_date=lte.${range.to}&order=id.asc`,
        );
        const data = raw
          .filter((d) => matches(args.query, d.description, d.reference))
          .filter(
            (d) =>
              !args.state ||
              args.state === "all" ||
              d.reconciliation_status === args.state,
          )
          .map((d) => ({
            ...d,
            bank:
              accounts.find((a) => a.id === d.bank_account_id)?.account_name ||
              d.bank_account_id,
          }));
        return tableResult(
          "get_bank_movements",
          "finance",
          "Cartolas y conciliacion",
          data,
          columns(
            "transaction_date:Fecha",
            "bank:Cuenta",
            "description:Descripcion",
            "reference:Referencia",
            "amount:Monto original",
            "currency:Moneda",
            "reconciliation_status:Conciliacion",
          ),
          "/finanzas-contabilidad?view=reconcile",
          args,
        );
      },
    );
    this.add(
      "get_checks",
      "finance",
      "Cheques reales en cartera, depositados, cobrados o protestados. Un cheque no es dinero disponible en banco.",
      {
        ...paging,
        state: choice(
          "all",
          "portfolio",
          "deposited",
          "collected",
          "protested",
          "replaced",
          "voided",
        ),
      },
      async (args) => {
        const entity = await this.source.entity();
        const data = (
          await this.source.all(
            `accounting_checks?select=id,customer_name,bank_name,check_number,amount_clp,received_on,due_on,deposited_on,status,updated_at&entity_id=eq.${entity}&order=id.asc`,
          )
        )
          .filter((d) => matches(args.query, d.customer_name, d.check_number))
          .filter(
            (d) =>
              args.state === "all" || d.status === (args.state || "portfolio"),
          );
        const result = tableResult(
          "get_checks",
          "finance",
          "Cheques",
          data,
          columns(
            "customer_name:Cliente",
            "bank_name:Banco",
            "check_number:Cheque",
            "due_on:Vencimiento",
            "amount_clp:Monto CLP",
            "status:Estado",
          ),
          "/finanzas-contabilidad?view=checks",
          args,
        );
        result.data = {
          ...object(result.data),
          selected_total_clp: decimalSum(data.map((d) => d.amount_clp)),
        };
        return result;
      },
    );
    this.add(
      "generate_business_report",
      "customers",
      "Informe transversal obligatorio para 'como esta el negocio' o informe ejecutivo. Recopila stock, clientes, finanzas, importaciones, campanas, contenido y agentes segun permisos. No ocultar secciones faltantes.",
      {},
      async () => {
        const plan: Array<[string, Domain, Row]> = [
          [
            "search_products",
            "products",
            { stock_filter: "low", threshold: 10, limit: 10 },
          ],
          ["search_customers", "customers", { inactive_days: 60, limit: 10 }],
          ["get_financial_summary", "finance", {}],
          ["get_imports", "foreign_trade", { state: "upcoming", limit: 10 }],
          ["get_campaigns", "campaigns", { limit: 10 }],
          [
            "get_content",
            "content",
            { view: "pending", period: "all", limit: 10 },
          ],
          ["get_agent_activity", "agents", { limit: 7 }],
        ];
        const sections: ReadResult[] = [];
        for (const [name, domain, args] of plan)
          if (canReadDomain(this.source.actor.role, domain))
            sections.push(await this.execute(name, args));
        return readResult(
          "generate_business_report",
          "customers",
          "Informe ejecutivo con fuentes reales por modulo autorizado.",
          { sections },
          sections.flatMap((s) => s.evidence),
          {
            status: sections.some(
              (s) => s.status !== "ok" && s.status !== "empty",
            )
              ? "partial"
              : "ok",
            warnings: sections.flatMap((s) => s.warnings),
            coverage: {
              complete: sections.every((s) => s.coverage.complete),
              totalMatched: sections.length,
              returned: sections.length,
            },
          },
        );
      },
    );
    this.add(
      "search_products",
      "products",
      "Busca productos por nombre, plural, modelo, SKU o enlace de climactiva.cl. Cruza catalogo y detalle de bodegas Facto. Para cuanto stock tenemos usa stock_filter=all: no ocultes productos con cantidad desconocida. known/zero/low/unknown solo si el usuario pide ese filtro. Varios modelos no son un solo producto. Cantidades con fuente y fecha, no inventario en vivo.",
      {
        ...paging,
        query: { ...paging.query, maxLength: 1000, description: "Nombre, modelo, SKU o URL completa del producto solicitado. Conserva el enlace cuando el usuario lo entrega." },
        stock_filter: choice("all", "known", "zero", "low", "unknown"),
        threshold: integer(0, 1000000),
        result_scope: choice("page", "all_matches"),
      },
      async (args) => {
        const warnings: string[] = [];
        const load = async (label: string, read: () => Promise<Row[]>) => {
          try { return await read(); }
          catch (error) {
            if (this.source.signal?.aborted) throw error;
            warnings.push(`${label} no disponible; la cobertura de la busqueda es incompleta.`);
            return [];
          }
        };
        const snapshots = await load("Resumen de inventario Facto", () => this.source.records("inventory_snapshots"));
        const details = await load("Detalle de productos Facto", () => this.source.records("product_details"));
        const catalog = await load("Catalogo Tiendanube", () => this.source.all("content_products?select=id,sku,name,brand,description_text,product_url,last_synced_at&order=id.asc"));
        if (!snapshots.length && !details.length && !catalog.length) throw new CopilotDataError("No hay un inventario consultable. No es posible afirmar existencias o agotados.");
        const matched = findProducts(resolveProducts(snapshots, details, catalog, canReadDomain(this.source.actor.role, "finance")), args.query).map((product) => {
          const safe = { ...product };
          delete safe.search_descriptions;
          return safe;
        });
        const data = matched
          .filter((p) =>
            args.stock_filter === "zero"
              ? p.stock === 0
              : args.stock_filter === "low"
                ? typeof p.stock === "number" && p.stock < Number(args.threshold ?? 10)
                : args.stock_filter === "unknown"
                  ? !p.stock_known
                  : args.stock_filter === "known"
                    ? typeof p.stock === "number"
                    : true,
          )
          .sort((a, b) => String(a.name).localeCompare(String(b.name), "es"));
        const result = tableResult(
          "search_products",
          "products",
          "Productos y stock Facto",
          data,
          columns(
            "sku:SKU",
            "name:Producto",
            "stock:Unidades disponibles",
            "stock_source:Fuente de stock",
            "stock_updated_at:Stock observado",
            "price:Precio",
            "currency:Moneda",
            "updated_at:Actualizado",
          ),
          "/agentes/logistics/dashboard",
          args.result_scope === "all_matches" ? { ...args, offset: 0, limit: Math.max(1, data.length) } : args,
          [
            ...warnings,
            ...new Set(data.slice(Number(args.offset || 0), Number(args.offset || 0) + Number(args.limit || 25)).flatMap((p) => (p.stock_warnings as string[]).map((warning) => `${p.sku}: ${warning}`))),
            ...(data.some((p) => p.match_type === "approximate_name") ? ["Coincidencias aproximadas por nombre: confirmar modelo o SKU antes de comprometer existencias."] : []),
            "El catalogo se usa para identificar nombre y enlace; no se suma su stock al inventario Facto. Cada producto conserva la fecha real de su cantidad.",
            "La demanda corresponde al intervalo observado de cada producto; no a un mes solicitado distinto.",
          ],
        );
        result.data = { ...object(result.data), identity_matches: matched.length, unknown_stock_matches: matched.filter((p) => p.stock === null).length, stock_filter: args.stock_filter || "all" };
        if (!data.length) result.summary = matched.length
          ? `Se encontraron ${matched.length} productos, pero ninguno cumple el filtro de stock. Esto no significa que esten agotados; ${matched.filter((p) => p.stock === null).length} tienen cantidad desconocida.`
          : "No se encontro una coincidencia para ese nombre, SKU o enlace en las fuentes consultadas. No es evidencia de stock cero; confirma el modelo o SKU.";
        if (data.length && data.every((p) => p.stock === null)) result.summary = `Se encontraron ${data.length} productos, pero su cantidad no esta verificada. Stock desconocido, no cero.`;
        if (warnings.length) {
          result.coverage.complete = false;
          result.status = data.length ? "partial" : "unavailable";
        }
        return result;
      },
    );
    this.add(
      "get_price_list",
      "products",
      "Lista comercial: SKU, nombre, precio neto de venta Facto, moneda y stock verificado. Busca con los mismos nombres, plurales y enlaces de search_products. Usar SIEMPRE para preguntas de precio o listas Excel para clientes, incluso una pregunta corta continuando una consulta de precios. segment=source para precio de venta habitual, no inventar segmento ni descuentos. client_price_list contiene el respaldo completo exportable de productos disponibles, no solo la pagina. Para varios tipos de producto hacer una consulta por tipo, nunca unir sus nombres como un unico producto.",
      {
        ...paging,
        query: { ...paging.query, maxLength: 1000 },
        stock_filter: choice("all", "available"),
        scope: choice("search", "catalog"),
        result_scope: choice("page", "all_matches"),
        segment: choice("source", "distributor", "installer", "consumer"),
        list_id: string,
      },
      async (args) => {
        if (args.segment && args.segment !== "source")
          return readResult(
            "get_price_list",
            "products",
            "No hay un mapeo autorizado de listas por segmento en el CRM. Puedo mostrar los precios de origen, pero no inventar una tarifa de distribuidores o instaladores.",
            null,
            [
              {
                label: "Catalogo",
                entityType: "products",
                path: "/contenido?view=library",
              },
            ],
            { status: "needs_clarification" },
          );
        const details = await this.source.records("product_details");
        const snapshots = await this.source.records("inventory_snapshots");
        const catalog = await this.source.all("content_products?select=id,sku,name,brand,description_text,product_url,last_synced_at&order=id.asc");
        const currencies = factoCurrencies(typeof Deno !== "undefined" ? Deno.env.get("FACTO_CURRENCY_MAP_JSON") : undefined);
        const resolved = productPrices(snapshots, details, catalog, args, currencies);
        if (!args.list_id && resolved.availableLists.length > 1) return readResult(
          "get_price_list", "products", "Hay varias listas de precios Facto. Selecciona una lista antes de preparar precios para clientes.",
          { available_list_ids: resolved.availableLists }, [], { status: "needs_clarification" },
        );
        const data = args.scope === "catalog" || args.stock_filter === "available" ? resolved.records.filter((p) => typeof p.stock === "number" && p.stock > 0) : resolved.records;
        const clientRows = clientPriceRows(data, args.scope === "catalog");
        if (clientRows.length > 1000) throw new CopilotDataError("Acota los productos para preparar una lista completa de hasta 1000 filas.", "COVERAGE_LIMIT");
        const result = tableResult(
          "get_price_list",
          "products",
          "Precios de origen Facto",
          data,
          columns(
            "sku:SKU",
            "name:Producto",
            "net:Precio neto",
            "stock:Stock registrado",
            "currency:Moneda",
            "list_id:Lista Facto",
          ),
          "/contenido?view=library",
          args.result_scope === "all_matches" ? { ...args, offset: 0, limit: Math.max(1, data.length) } : args,
          [
            "Precios netos de venta de la lista Facto, sin IVA ni descuentos inventados. El stock y precio conservan sus fechas; no son una consulta en vivo.",
            ...(data.length !== clientRows.length ? [`${data.length - clientRows.length} filas no aptas para envio: stock o precio no positivo, moneda/fecha pendiente o coincidencia aproximada. No se incluyen en el Excel comercial.`] : []),
          ],
        );
        result.data = { ...object(result.data), identity_matches: resolved.products.length, client_price_list: { scope: args.scope || "search", complete: true, total: clientRows.length, excluded: data.length - clientRows.length, records: clientRows } };
        if (!data.length) result.summary = resolved.products.length ? "Se encontraron productos, pero ninguno cumple el filtro de disponibilidad solicitado. No se inventan cantidades ni precios." : "No se encontro el producto por ese nombre, SKU o enlace. Una busqueda vacia no acredita ausencia de precios; confirma el SKU.";
        return result;
      },
    );
    this.add(
      "search_customers",
      "customers",
      "Clientes, empresas, categorias CRM, ultima compra e historial comercial. Busca por nombre o RUT; category usa tipo real (distribuidor, instalador_grande, tecnico, etc). inactive_days no incluye clientes sin fecha conocida.",
      { ...paging, category: string, inactive_days: integer(1, 3650) },
      async (args) => {
        const companies = await this.source.all(
          "companies?select=id,name,legal_name,rut,type,priority,city,region,description,status,updated_at&order=id.asc",
        );
        const snapshots = await this.source.records("commercial_snapshots");
        const latest = snapshots.sort((a, b) =>
          String(b.updated_at).localeCompare(String(a.updated_at)),
        )[0];
        const commercial = rows(object(latest?.payload).customers);
        const key = (value: unknown) =>
          String(value || "")
            .replace(/[^0-9kK]/g, "")
            .toUpperCase();
        const used = new Set<Row>();
        const project = (company: Row, customer: Row = {}): Row => {
          const last = customer.last_purchase_at || null;
          const days = last
            ? Math.floor(
                (Date.parse(todayChile()) -
                  Date.parse(String(last).slice(0, 10))) /
                  86400000,
              )
            : null;
          return {
            id: company.id || customer.customer_key,
            name: company.name || customer.name || customer.legal_name,
            rut: company.rut || customer.tax_id,
            category: company.type || null,
            priority: company.priority || null,
            description: company.description || null,
            city: company.city || customer.city,
            last_purchase_at: last,
            inactive_days: Number.isFinite(days) ? days : null,
            product_history: Array.isArray(customer.top_products)
              ? customer.top_products.slice(0, 10)
              : Array.isArray(customer.product_history)
                ? customer.product_history.slice(0, 10)
                : null,
            ...(canReadDomain(this.source.actor.role, "sales")
              ? {
                  net_sales_facto: customer.facto_net_sales ?? null,
                  net_sales_by_month: customer.facto_net_sales_by_month || null,
                }
              : {}),
            updated_at: latest?.updated_at || company.updated_at,
          };
        };
        const data = companies.map((company) => {
          const candidates = key(company.rut)
            ? commercial.filter((c) => key(c.tax_id) === key(company.rut))
            : [];
          if (candidates.length === 1) used.add(candidates[0]);
          return project(company, candidates.length === 1 ? candidates[0] : {});
        });
        data.push(
          ...commercial.filter((c) => !used.has(c)).map((c) => project({}, c)),
        );
        const filtered = data
          .filter((c) => matches(args.query, c.name, c.rut))
          .filter((c) => !args.category || matches(args.category, c.category))
          .filter(
            (c) =>
              !args.inactive_days ||
              (c.inactive_days !== null &&
                Number(c.inactive_days) >= Number(args.inactive_days)),
          );
        return tableResult(
          "search_customers",
          "customers",
          "Clientes y antecedentes comerciales",
          filtered,
          columns(
            "name:Cliente",
            "rut:RUT",
            "category:Categoria CRM",
            "city:Ciudad",
            "last_purchase_at:Ultima compra",
            "inactive_days:Dias sin comprar",
          ),
          "/empresas",
          args,
          [
            "Solo se unen identidades por RUT unico. Sin RUT o con ambiguedad, los registros permanecen separados.",
            "Una fecha de compra desconocida no significa inactividad.",
          ],
        );
      },
    );
    this.add(
      "get_financial_summary",
      "finance",
      "Resumen actual desde el mismo servicio del dashboard financiero, bancos, cobranza, costos, rentabilidad, cobertura y advertencias. No usa el snapshot contable antiguo.",
      {},
      async () => {
        const data = await this.source.api("accounting-center", "summary");
        const summary = object(data.summary),
          dashboard = object(data.dashboard);
        const warnings = Array.isArray(dashboard.warnings)
          ? dashboard.warnings.map(String)
          : [];
        warnings.push("El resultado es provisional: este resumen no certifica el cierre contable ni resuelve movimientos pendientes de clasificar.");
        const missingCost = numeric(object(dashboard.costCoverage).missingSalesCost);
        if (missingCost && missingCost > 0) warnings.push(`${missingCost} documentos de venta requieren costo exacto; la rentabilidad puede estar sobreestimada.`);
        if (dashboard.available === false) {
          dashboard.current = null;
          dashboard.monthly = [];
          warnings.push("No hay cobertura suficiente para mostrar resultado o tendencias; no se reemplazan con cero.");
        }
        if (summary.receivables_suppressed) {
          summary.receivables = null;
          summary.receivables_overdue = null;
          warnings.push("Cartera no certificable: ultimo respaldo incompleto.");
        }
        if (object(data.factoFreshness).stale)
          warnings.push(
            "Facto tiene cambios pendientes de consolidar en contabilidad.",
          );
        return readResult(
          "get_financial_summary",
          "finance",
          "Posicion financiera actual y resultado contable del ejercicio.",
          { ...data, summary, dashboard },
          [
            {
              label: "Dashboard financiero",
              entityType: "finance",
              path: "/finanzas-contabilidad?view=dashboard",
              observedAt:
                String(
                  object(data.factoFreshness).integrationUpdatedAt || "",
                ) || null,
            },
          ],
          { warnings, status: warnings.length ? "partial" : "ok" },
        );
      },
    );
    this.add(
      "get_accounting_report",
      "finance",
      "Informes reales de doble partida: balance8, trial, income (ventas/costos/rentabilidad), cashflow. Periodos calendario Chile. No confundir flujo con utilidad.",
      {
        ...paging,
        ...period,
        kind: choice("balance8", "trial", "income", "cashflow"),
      },
      async (args) => {
        const range = dateRange(args),
          entity = await this.source.entity(),
          kind = String(args.kind || "income");
        const data = await this.source.api(
          "accounting-center",
          `reports?entityId=${entity}&kind=${kind}&from=${range.from}&to=${range.to}`,
        );
        const reportRows = rows(data.rows);
        const result = tableResult(
          "get_accounting_report",
          "finance",
          `Informe ${kind} ${range.from} a ${range.to}`,
          reportRows,
          Object.keys(reportRows[0] || {}).map((key) => ({ key, label: key })),
          "/finanzas-contabilidad?view=reports",
          { ...args, limit: args.limit || 100 },
        );
        result.data = { ...data, rows: result.table!.rows, period: range };
        result.coverage = { ...result.coverage, ...range };
        result.warnings.push(
          "Resultado provisional salvo cierre y cobertura confirmados en Finanzas. Las cifras provienen de los asientos registrados.",
        );
        return result;
      },
    );
    this.add(
      "get_accounts_receivable",
      "finance",
      "Cartera de cobro y documentos impagos. Separa saldo informado por Facto de saldo conciliado, pagos parciales y vencimiento desconocido. Consulta completa paginada.",
      { ...paging, state: choice("pending", "overdue", "all") },
      (args) => this.obligations(args, false),
    );
    this.add(
      "get_accounts_payable",
      "finance",
      "Obligaciones a proveedores y pagos pendientes, por nombre o RUT.",
      { ...paging, state: choice("pending", "overdue", "all") },
      (args) => this.obligations(args, true),
    );
    this.add(
      "get_financial_documents",
      "finance",
      "Documentos de venta/compra Facto ya consolidados, folios, fechas, RUT, neto, IVA y total. No sumar como pagos. Para total neto contable usar get_accounting_report.",
      { ...paging, ...period },
      async (args) => {
        const range = dateRange(args),
          entity = await this.source.entity();
        const data = await this.source.all(
          `accounting_source_documents?select=id,source_type,document_type,folio,counterpart_tax_id,counterpart_name,issued_on,currency,net_amount,tax_amount,total_amount,status,updated_at&entity_id=eq.${entity}&issued_on=gte.${range.from}&issued_on=lte.${range.to}&order=id.asc`,
        );
        return tableResult(
          "get_financial_documents",
          "finance",
          "Documentos financieros",
          data.filter((d) =>
            matches(
              args.query,
              d.folio,
              d.counterpart_name,
              d.counterpart_tax_id,
            ),
          ),
          columns(
            "issued_on:Fecha",
            "document_type:Tipo",
            "folio:Folio",
            "counterpart_name:Contraparte",
            "net_amount:Neto",
            "tax_amount:IVA",
            "total_amount:Total",
            "currency:Moneda",
          ),
          "/finanzas-contabilidad?view=sources",
          args,
        );
      },
    );
    this.add(
      "get_top_products",
      "sales",
      "Ranking desde lineas de facturas y boletas Facto, por unidades y venta neta, con periodo y documentos verificables. Marca, nombre y descripcion cruzados por SKU con Tiendanube. No utiliza snapshots de inventario ni predice demanda futura. La cobertura puede ser parcial por documentos o notas sin detalle.",
      { ...paging, ...period, metric: choice("units", "net_sales"), result_scope: choice("page", "all_matches"), group_by: choice("product", "month", "year"), detail_level: choice("summary", "evidence"), identity_scope: choice("all_lines", "catalog") },
      async (args) => {
        const { range, sales } = await this.documentedProductSales(args);
        const metric = args.metric === "net_sales" ? "net_sales" : "units_sold";
        const unlinked = sales.records.filter((r) => !r.sku).length;
        const data = sales.records.filter((r) => args.identity_scope !== "catalog" || r.sku).map((r) => {
          const { evidence, ...summary } = r;
          return args.detail_level === "evidence" ? r : { ...summary, evidence_count: rows(evidence).length };
        }).sort((a, b) => (args.group_by === "month" || args.group_by === "year" ? String(a.period).localeCompare(String(b.period)) : 0) || (metric === "net_sales" && a.currency !== b.currency ? String(a.currency).localeCompare(String(b.currency)) : Number(b[metric] ?? -Infinity) - Number(a[metric] ?? -Infinity)));
        const warnings = ["Ranking historico de ventas documentadas, no demanda futura ni cobros. Monedas separadas; no sumar ni comparar importes entre monedas.", "La marca proviene del catalogo Tiendanube o de coincidencias del texto de la linea; no se modifica la ficha del producto."];
        if (sales.coverage.problems.length) warnings.push(`${sales.coverage.problems.length} documentos o lineas requieren revision. Ranking provisional: no acredita todas las ventas netas del periodo.`);
        if (data.some((r) => r.net_sales === null)) warnings.push("Hay importes sin validar contra el neto del documento; no se inventan descuentos ni ventas netas.");
        if (unlinked) warnings.push(`${unlinked} grupos documentales sin SKU confirmado pueden incluir servicios o fletes. No equivalen a productos del catalogo. Usa identity_scope=catalog para productos identificados; all_lines para supervisar pendientes.`);
        const result = tableResult(
          "get_top_products",
          "sales",
          `Ventas documentadas ${range.from} a ${range.to}`,
          data,
          columns(
            "period:Periodo",
            "sku:SKU",
            "name:Producto",
            "units_sold:Unidades facturadas",
            "net_sales:Venta neta documentada",
            "currency:Moneda",
            "document_count:Documentos",
            "identity:Identificacion",
          ),
          "/finanzas-contabilidad?view=sources",
          args.result_scope === "all_matches" ? { ...args, offset: 0, limit: Math.max(1, data.length) } : args,
          warnings,
        );
        result.data = { ...object(result.data), period: range, result_scope: args.result_scope || "page", group_by: args.group_by || "product", identity_scope: args.identity_scope || "all_lines", unlinked_groups: unlinked, document_coverage: sales.coverage };
        if (args.identity_scope === "catalog" && unlinked) { result.status = "partial"; result.coverage.complete = false; }
        if (sales.coverage.problems.length || data.some((r) => r.net_sales === null)) { result.status = "partial"; result.coverage.complete = false; }
        return result;
      },
    );
    this.add(
      "get_product_sales_documents",
      "sales",
      "A quien vendimos un producto: clientes y RUT desde el receptor de facturas/boletas emitidas, con folio, fecha y cantidad por linea. Incluye documentos pagados, no depende de cuentas por cobrar. Reutiliza el mismo motor que get_top_products. reference_units contrasta una cantidad previa pero NO filtra facturas por cantidad exacta.",
      { ...paging, ...period, result_scope: choice("page", "all_matches"), reference_units: integer(1, 1000000000) },
      async (args) => {
        if (!String(args.query || "").trim()) throw new CopilotDataError("Indica el producto o SKU; una cantidad sola no identifica una venta.", "INVALID_ARGUMENTS");
        const { range, sales } = await this.documentedProductSales({ ...args, group_by: "product" });
        const data = sales.records.flatMap((product) => rows(product.evidence).map<Row>((line) => ({ ...line, sku: product.sku, product: product.name, currency: product.currency, updated_at: product.updated_at }))).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.folio).localeCompare(String(b.folio), "es", { numeric: true }) || Number(a.line) - Number(b.line));
        const warnings = ["El comprador es el receptor del documento emitido, no necesariamente quien transfirio el pago. No se consultan ni suman cuentas por cobrar.", "Las cantidades corresponden a lineas documentadas: pueden repartirse entre varios clientes y facturas. Notas pendientes o documentos inconsistentes hacen provisional la cobertura."];
        if (data.some((r) => !r.customer || !r.tax_id)) warnings.push("Algunos documentos no identifican completamente al receptor; no se inventan clientes ni RUT.");
        if (sales.coverage.problems.length) warnings.push(`${sales.coverage.problems.length} documentos o lineas requieren revision.`);
        if (data.some((r) => r.net === null)) warnings.push("Hay importes pendientes de validar. Neto desconocido no significa cero ni factura impaga.");
        const totals = sales.records.map((p) => ({ sku: p.sku, product: p.name, currency: p.currency, units: p.units_sold, documents: p.document_count }));
        const reference = args.reference_units == null ? null : { units: args.reference_units, matches: totals.length === 1 ? Number(totals[0].units) === args.reference_units : null };
        const result = tableResult("get_product_sales_documents", "sales", `Clientes y documentos de venta ${range.from} a ${range.to}`, data, columns("date:Fecha", "folio:Folio", "type:Tipo DTE", "customer:Cliente", "tax_id:RUT", "sku:SKU", "product:Producto", "quantity:Unidades", "net:Neto de linea", "currency:Moneda"), "/finanzas-contabilidad?view=facto", args.result_scope === "all_matches" ? { ...args, offset: 0, limit: Math.max(1, data.length) } : args, warnings);
        result.data = { ...object(result.data), period: range, totals_by_product: totals, reference_quantity: reference, document_coverage: sales.coverage };
        if (sales.coverage.problems.length || data.some((r) => !r.customer || r.net === null)) { result.status = "partial"; result.coverage.complete = false; }
        return result;
      },
    );
    this.add(
      "get_imports",
      "foreign_trade",
      "Operaciones existentes, contenedores, produccion, transito y ETA. upcoming ordena por proxima llegada conocida. Consultar get_import_details para cantidades y costos.",
      {
        ...paging,
        state: choice("all", "production", "in_transit", "upcoming"),
      },
      async (args) => {
        const data = await this.source.all(
          "import_shipments?select=id,title,reference,status,estimated_arrival,estimated_departure,value_usd,supplier_id,supplier_proforma_number,origin_port,destination_port,updated_at&order=id.asc",
        );
        const filtered = data
          .filter((d) =>
            matches(
              args.query,
              d.title,
              d.reference,
              d.supplier_proforma_number,
            ),
          )
          .filter((d) =>
            args.state === "production"
              ? d.status === "production"
              : args.state === "in_transit"
                ? d.status === "in_transit"
                : args.state === "upcoming"
                  ? !["received", "closed", "cancelled", "quotation", "proforma_received", "negotiation"].includes(
                      String(d.status),
                    )
                  : true,
          )
          .sort((a, b) =>
            String(a.estimated_arrival || "9999").localeCompare(
              String(b.estimated_arrival || "9999"),
            ),
          );
        return tableResult(
          "get_imports",
          "foreign_trade",
          "Importaciones existentes",
          filtered,
          columns(
            "id:Operacion",
            "title:Nombre",
            "status:Estado",
            "estimated_arrival:Llegada estimada",
            "value_usd:Valor USD",
          ),
          "/comercio-exterior?view=operations",
          args,
          [
            "Una ETA es estimada. Sin fecha registrada no se puede asegurar cual contenedor llegara primero.",
          ],
        );
      },
    );
    this.add(
      "get_import_details",
      "foreign_trade",
      "Detalle de operacion existente: productos, SKU, unidades, volumen, costos, escenarios y proveedor. Reutiliza RPC de Comercio Exterior; no crea otro agente.",
      {
        operation_id: string,
        offset: integer(0, 10000),
        limit: integer(1, 100),
      },
      async (args) => {
        const id = String(args.operation_id || "");
        if (
          !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)
        )
          throw new CopilotDataError(
            "Selecciona una operacion valida usando get_imports.",
            "INVALID_ARGUMENTS",
          );
        const raw = object(
          await this.source.rpc("foreign_trade_operation_detail", {
            p_operation_id: id,
          }),
        );
        const operation = object(raw.operation);
        const lineRows = rows(raw.lines).map((r) =>
          pick(r, [
            "id",
            "sku",
            "supplier_sku",
            "product_name",
            "quantity",
            "currency",
            "unit_factory_cost",
            "exw_total",
            "fob_total",
            "cif_total",
            "cbm_total",
            "gross_weight_kg",
            "data_source",
          ]),
        );
        const result = tableResult(
          "get_import_details",
          "foreign_trade",
          "Productos de la importacion",
          lineRows,
          columns(
            "sku:SKU",
            "supplier_sku:SKU proveedor",
            "product_name:Producto",
            "quantity:Unidades",
            "unit_factory_cost:Costo unitario",
            "currency:Moneda",
          ),
          `/comercio-exterior?view=operations&operation=${id}`,
          { ...args, limit: args.limit || 100 },
        );
        result.data = {
          operation: pick(operation, [
            "id",
            "title",
            "reference",
            "status",
            "estimated_arrival",
            "value_usd",
          ]),
          totals: raw.totals || null,
          costs: rows(raw.costs).map((r) =>
            pick(r, [
              "id",
              "name",
              "category",
              "currency",
              "amount_original",
              "amount_clp",
              "source_type",
            ]),
          ),
          lines: result.table!.rows,
          scenarios: rows(raw.scenarios).map((r) =>
            pick(r, [
              "id",
              "name",
              "status",
              "exchange_rate_clp",
              "target_margin_percent",
            ]),
          ),
        };
        result.freshness.sourceObservedAt =
          String(operation.updated_at || "") || null;
        return result;
      },
    );
    this.add(
      "get_content",
      "content",
      "Publicaciones reales Instagram/Facebook. view published, pending o scheduled; calendario por Chile. Esta semana es lunes a hoy, no ultimos 7 dias. all no limita fecha.",
      {
        ...paging,
        ...period,
        channel: choice("all", "instagram", "facebook"),
        view: choice("published", "pending", "scheduled", "all"),
      },
      async (args) => {
        const range = dateRange({ ...args, period: args.period || "all" });
        const publications = await this.publications(args.channel);
        const filtered = publications
          .filter((p) =>
            args.view === "pending"
              ? ["draft", "pending_approval", "approved", "failed"].includes(
                  String(p.status),
                )
              : !args.view || args.view === "all" || p.status === args.view,
          )
          .filter((p) =>
            inRange(p.published_at || p.scheduled_at || p.created_at, range),
          )
          .filter((p) => matches(args.query, p.product, p.body));
        return tableResult(
          "get_content",
          "content",
          "Centro de Contenido",
          filtered,
          columns(
            "channel:Red",
            "product:Producto",
            "status:Estado",
            "published_at:Publicado",
            "scheduled_at:Programado",
            "body:Contenido",
          ),
          "/contenido?view=publications",
          args,
        );
      },
    );
    this.add(
      "get_content_metrics",
      "content",
      "Rendimiento Instagram/Facebook de publicaciones del periodo: ultima medicion acumulada por publicacion, nunca suma snapshots. Alcance agregado no es audiencia unica; faltantes null.",
      { ...period, channel: choice("all", "instagram", "facebook") },
      async (args) => {
        const range = dateRange({ ...args, period: args.period || "all" });
        const publications = (await this.publications(args.channel)).filter(
          (p) => p.status === "published" && inRange(p.published_at, range),
        );
        const ids = new Set(publications.map((p) => String(p.id)));
        const metrics = latestMetrics(
          (
            await this.source.all(
              "content_metrics?select=id,publication_id,observed_at,impressions,reach,likes,comments,shares,saves,clicks&order=id.asc",
            )
          ).filter((m) => ids.has(String(m.publication_id))),
        );
        const totals = Object.fromEntries(
          [
            "impressions",
            "reach",
            "likes",
            "comments",
            "shares",
            "saves",
            "clicks",
          ].map((key) => [
            key,
            metrics.length && metrics.length === publications.length
              ? decimalSum(metrics.map((m) => m[key]))
              : null,
          ]),
        );
        return readResult(
          "get_content_metrics",
          "content",
          "Ultimas metricas acumuladas de las publicaciones del periodo.",
          {
            period: range,
            publications: publications.length,
            measured: metrics.length,
            totals,
            measurements: metrics.slice(0, 100),
          },
          [
            {
              label: "Metricas de contenido",
              entityType: "content",
              path: "/contenido?view=dashboard",
              observedAt: observedAt(metrics),
            },
          ],
          {
            status:
              metrics.length === publications.length && metrics.length > 0
                ? "ok"
                : "partial",
            warnings: [
              "Estas son metricas acumuladas de publicaciones del periodo, no interacciones ocurridas exclusivamente dentro de el.",
              "Alcance sumado no representa personas unicas; null significa cobertura faltante.",
            ],
            coverage: {
              complete: metrics.length === publications.length,
              totalMatched: publications.length,
              returned: metrics.length,
              ...range,
            },
          },
        );
      },
    );
    this.add(
      "get_campaigns",
      "campaigns",
      "Campanas existentes y desempeno registrado (enviados, respuestas, interesados). No envia correos ni crea campanas.",
      { ...paging, state: string },
      async (args) => {
        const campaigns = await this.source.all(
          "campaigns?select=id,name,type,status,segment,send_at,updated_at&order=id.asc",
        );
        const recipients = await this.source.all(
          "campaign_recipients?select=id,campaign_id,sent_at,replied_at,interested&order=id.asc",
        );
        const data = campaigns
          .filter((c) => matches(args.query, c.id, c.name, c.segment))
          .filter((c) => !args.state || c.status === args.state)
          .map((c) => {
            const assigned = recipients.filter((r) => r.campaign_id === c.id);
            return {
              ...c,
              recipients: assigned.length,
              sent: assigned.filter((r) => r.sent_at).length,
              replies: assigned.filter((r) => r.replied_at).length,
              interested: assigned.filter((r) => r.interested).length,
            };
          });
        return tableResult(
          "get_campaigns",
          "campaigns",
          "Campanas CRM",
          data,
          columns(
            "name:Campana",
            "type:Canal",
            "status:Estado",
            "recipients:Destinatarios",
            "sent:Enviados",
            "replies:Respuestas",
            "interested:Interesados",
          ),
          "/campanas",
          args,
          [
            "Estos indicadores reflejan el registro CRM; no equivalen a aperturas o entregabilidad de Gmail.",
          ],
        );
      },
    );
    this.add(
      "get_agent_activity",
      "agents",
      "Actividad de los agentes especializados existentes, sus ultimos resultados y errores. No inicia tareas ni duplica agentes.",
      {
        ...paging,
        agent: choice(
          "commercial",
          "marketing",
          "finance",
          "collections",
          "logistics",
          "foreign_trade",
          "executive",
        ),
      },
      async (args) => {
        const data = await this.source.all(
          "business_agent_tasks?select=id,agent_type,action,status,result_summary:result->>summary,result_human_summary:result->>humanSummary,error_code,completed_at,updated_at&order=id.asc",
        );
        const filtered = data
          .filter((d) => !args.agent || d.agent_type === args.agent)
          .sort((a, b) =>
            String(b.updated_at).localeCompare(String(a.updated_at)),
          )
          .map((d) => ({
            ...pick(d, [
              "id",
              "agent_type",
              "action",
              "status",
              "error_code",
              "completed_at",
              "updated_at",
            ]),
            summary: String(
              d.result_summary ||
                d.result_human_summary ||
                "Sin resumen estructurado",
            ).slice(0, 4000),
          }));
        return tableResult(
          "get_agent_activity",
          "agents",
          "Agentes existentes",
          filtered,
          columns(
            "agent_type:Agente",
            "action:Accion",
            "status:Estado",
            "completed_at:Finalizado",
            "summary:Resumen",
          ),
          "/agentes",
          args,
          [
            "Los resultados son historicos; su fecha no garantiza datos actuales.",
          ],
        );
      },
    );
    this.add(
      "get_agent_report",
      "agents",
      "Consulta de solo lectura del ultimo informe completado de un agente. Sin section devuelve indice y fechas; con section recupera filas del detalle existente, paginadas. No ejecuta agentes ni propuestas. Los informes historicos no sustituyen cifras actuales de modulos.",
      { ...paging, agent: choice("commercial", "marketing", "finance", "collections", "logistics", "foreign_trade", "executive"), section: { ...string, description: "null para consultar indice. Luego copia EXACTAMENTE un valor de section del indice (por ejemplo top_rotation), sin traducirlo ni inventarlo." } },
      async (args) => {
        if (!args.agent) throw new CopilotDataError("Indica el agente que deseas consultar.", "INVALID_ARGUMENTS");
        const tasks = await this.source.select(`business_agent_tasks?select=id,agent_type,status,result,completed_at,updated_at&agent_type=eq.${args.agent}&status=eq.completed&order=completed_at.desc.nullslast,id.desc&limit=1`);
        const path = `/agentes/${args.agent}/dashboard`;
        if (!tasks.length) return tableResult("get_agent_report", "agents", "Sin informe completado", [], [], path, args, ["La ausencia de informe no significa ausencia de actividad del negocio."]);
        const { metadata, sections } = agentReport(tasks[0]);
        if (args.section && !Object.hasOwn(sections, String(args.section))) {
          const available = Object.keys(sections).map((section) => ({ section }));
          const retry = tableResult("get_agent_report", "agents", "Indice de secciones disponibles", available, [{ key: "section", label: "Seccion" }], path, { limit: available.length });
          retry.status = "needs_clarification";
          retry.warnings.push("La seccion solicitada no existe. Consulta nuevamente usando exactamente una de estas secciones; no es necesario pedir al usuario un nombre tecnico.");
          retry.data = { ...object(retry.data), report: metadata };
          return retry;
        }
        const data = args.section ? agentSectionRows(sections[String(args.section)]).filter((r) => matches(args.query, ...Object.values(r))) : Object.entries(sections).map(([section, value]) => ({ section, records: Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 1 }));
        const fields = [...new Set(data.flatMap((r) => Object.keys(r)))];
        const result = tableResult("get_agent_report", "agents", `Informe historico: ${args.agent}${args.section ? " / " + args.section : ""}`, data, fields.map((key) => ({ key, label: key })), path, args, ["Fecha de ejecucion no equivale a fecha de los datos. No sumar estas cifras a las de Facto o modulos: pueden representar las mismas operaciones.", "El detalle anidado extenso se identifica como abreviado; el informe original conserva la evidencia. Las propuestas requieren revision y no estan ejecutadas."]);
        result.data = { ...object(result.data), report: metadata };
        result.freshness.sourceObservedAt = String(metadata.source_updated_at || tasks[0].completed_at || "") || null;
        return result;
      },
    );
    this.add(
      "get_integration_status",
      "customers",
      "Estado y fecha de sincronizacion de Facto, Tiendanube, Gmail y WhatsApp. No devuelve credenciales ni contenido de correos.",
      {},
      async () => {
        const data = await this.source.all(
          "integration_connections?select=id,provider,status,last_success_at&order=id.asc",
        );
        return tableResult(
          "get_integration_status",
          "customers",
          "Estado de integraciones",
          data,
          columns(
            "provider:Proveedor",
            "status:Estado",
            "last_success_at:Ultima sincronizacion",
          ),
          this.source.actor.role === "administrador" ? "/administracion" : "/agentes",
          { limit: 100 },
        );
      },
    );
  }
  private async documentedProductSales(args: Row) {
    const range = dateRange({ ...args, period: args.period || "this_year" });
    const fields = "external_id,updated_at,header:payload->header,details:payload->details,totals:payload->totals,global_modifiers:payload->global_modifiers,document_number:payload->>document_number,document_status:payload->>document_status,document_type_taxbureau:payload->>document_type_taxbureau,received_issued_flag:payload->>received_issued_flag,issue_date:payload->>issue_date,currency_id:payload->>currency_id,net_amount:payload->>net_amount,receiver_legal_name:payload->>receiver_legal_name,receiver_tax_id_code:payload->>receiver_tax_id_code";
    const documents = await this.source.all(`integration_records?select=${fields}&provider=eq.facto&resource=eq.documents&order=id.asc`);
    const details = await this.source.all(`integration_records?select=${fields}&provider=eq.facto&resource=eq.document_details&order=id.asc`);
    const catalog = await this.source.all("content_products?select=id,sku,name,brand,description_text,product_url,last_synced_at&order=id.asc");
    const products = resolveProducts([], await this.source.records("product_details"), catalog, false);
    return { range, sales: productSales(documents, details, products, args.query, range, factoCurrencies(typeof Deno !== "undefined" ? Deno.env.get("FACTO_CURRENCY_MAP_JSON") : undefined), args.group_by) };
  }
  private async publications(channel: unknown): Promise<Row[]> {
    const channels = await this.source.select(
      "content_channels?select=id,code&order=id.asc",
    );
    const products = await this.source.all(
      "content_products?select=id,name&order=id.asc",
    );
    const data = await this.source.all(
      "content_publications?select=id,product_id,channel_id,status,body,published_at,scheduled_at,created_at,updated_at&order=id.asc",
    );
    return data
      .map((p) => ({
        ...p,
        body: String(p.body || "").slice(0, 1200),
        product:
          products.find((product) => product.id === p.product_id)?.name || null,
        channel: channels.find((c) => c.id === p.channel_id)?.code || null,
      }))
      .filter((p) => !channel || channel === "all" || p.channel === channel);
  }
  private async obligations(args: Row, payable: boolean): Promise<ReadResult> {
    const name = payable ? "get_accounts_payable" : "get_accounts_receivable",
      table = payable ? "accounting_payables" : "accounting_receivables",
      party = payable ? "supplier" : "customer";
    const entity = await this.source.entity();
    const data = await this.source.all(
      `${table}?select=*&entity_id=eq.${entity}&order=id.asc`,
    );
    const current = todayChile();
    const records = data
      .map((d) => ({
        id: d.id,
        name: d[`${party}_name`],
        rut: d[`${party}_tax_id`],
        folio: d.document_number,
        issued_on: d.issued_on,
        due_on: d.due_on,
        currency: d.currency,
        original_clp: d.original_amount_clp,
        paid_confirmed_clp: d.paid_amount_clp,
        balance_ledger_clp: d.balance_clp,
        balance_operational_clp: d.reported_balance_clp ?? d.balance_clp,
        balance_source:
          d.reported_balance_clp != null ? "Facto informado" : "CRM conciliado",
        reported_at: d.reported_at || null,
        updated_at: d.updated_at,
      }))
      .filter((d) => matches(args.query, d.name, d.rut, d.folio))
      .filter(
        (d) => args.state === "all" || Number(d.balance_operational_clp) > 0.5,
      )
      .filter(
        (d) =>
          args.state !== "overdue" || (d.due_on && String(d.due_on) < current),
      );
    const result = tableResult(
      name,
      "finance",
      payable ? "Cuentas por pagar" : "Cuentas por cobrar",
      records,
      columns(
        "name:Contraparte",
        "rut:RUT",
        "folio:Folio",
        "due_on:Vencimiento",
        "original_clp:Original CLP",
        "balance_operational_clp:Saldo operativo CLP",
        "balance_ledger_clp:Saldo conciliado CLP",
        "balance_source:Fuente saldo",
      ),
      `/finanzas-contabilidad?view=${payable ? "payables" : "receivables"}`,
      args,
      [
        "Saldo informado y saldo conciliado son fuentes diferentes; no se suman. Sin vencimiento no se puede afirmar mora.",
      ],
    );
    result.data = {
      ...object(result.data),
      selected_total_clp: decimalSum(
        records.map((r) => r.balance_operational_clp),
      ),
      as_of: current,
    };
    if (!payable) {
      const currentSummary = await this.source.api(
        "accounting-center",
        "summary",
      );
      const summary = object(currentSummary.summary);
      if (summary.receivables_suppressed) {
        result.status = "partial";
        result.data = { ...object(result.data), selected_total_clp: null };
        result.warnings.push(
          "La cartera tiene un respaldo parcial inconsistente; no se certifica el total.",
        );
      }
      result.data = {
        ...object(result.data),
        dashboard_total_clp: summary.receivables_suppressed
          ? null
          : summary.receivables,
        data_quality: summary.receivables_data_quality,
        freshness: currentSummary.factoFreshness,
      };
    }
    return result;
  }
}
