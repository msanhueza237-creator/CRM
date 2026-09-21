import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend } from "chart.js";
import type { AccountingSalesComparison, AccountingSalesPeriod } from "../../types/accounting";
import { dashboardDetailLink } from "../accounting/dashboardNavigation";
import "./salesComparison.css";

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend);
const money = (value: number | null) => value === null ? "Sin documentos" : value.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
const growth = (value: number | null) => value === null ? "Sin base comparable" : `${value > 0 ? "+" : ""}${value.toLocaleString("es-CL", { maximumFractionDigits: 1 })}%`;
const date = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString("es-CL", { day: "numeric", month: "short", year: "numeric" });
const tone = (value: number | null) => value === null || value === 0 ? "" : value > 0 ? "positive" : "negative";

function PeriodAmount({ period, label }: { period: AccountingSalesPeriod; label: string }) {
  return <Link to={dashboardDetailLink("sales-period-net", period.from, period.to)} aria-label={`${label}: ${money(period.netClp)}. Ver documentos`}>
    {money(period.netClp)} <ArrowUpRight size={14} />
  </Link>;
}

export function SalesComparison({ data, loading }: { data?: AccountingSalesComparison; loading: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current || !data) return;
    const chart = new Chart(canvas.current, {
      type: "bar",
      data: {
        labels: data.monthly.map(month => `${month.label}${month.partial ? " *" : ""}`),
        datasets: [
          { label: String(data.previousYear), data: data.monthly.map(month => month.previous.netClp), backgroundColor: "#ad694f", borderRadius: 2 },
          { label: String(data.year), data: data.monthly.map(month => month.current?.netClp ?? null), backgroundColor: "#138c96", borderRadius: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: context => `${context.dataset.label}: ${money(context.parsed.y)}`,
            footer: items => {
              const month = data.monthly[items[0]?.dataIndex];
              return month?.partial ? `Ambos años hasta el día ${Number(data.asOf.slice(8))}` : "";
            },
          } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, font: { size: 11 } } },
          y: { beginAtZero: true, ticks: { callback: value => new Intl.NumberFormat("es-CL", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value)) } },
        },
      },
    });
    return () => chart.destroy();
  }, [data]);

  if (!data) return <section className="overview-section sales-comparison" aria-label="Comparación anual de ventas">
    <div className="overview-heading"><h2>Comparación anual de ventas</h2></div>
    <p className="sales-comparison-note" role="status">{loading ? "Cargando ventas comparables…" : "Comparación anual no disponible. No se sustituyen los datos faltantes por cero."}</p>
  </section>;

  const partial = data.monthly.find(month => month.partial);
  return <section className="overview-section sales-comparison" aria-label="Comparación anual de ventas">
    <div className="overview-heading"><div><h2>Ventas {data.year} vs {data.previousYear}</h2><p>Ventas netas por emisión · sin IVA · notas de crédito descontadas</p></div></div>
    <div className="sales-comparison-totals">
      <div><span>{data.previousYear} · año completo</span><strong><PeriodAmount period={data.previousAnnual} label={`Total ${data.previousYear}`} /></strong><small>Enero a diciembre · {data.previousAnnual.documents} documentos</small></div>
      <div><span>{data.previousYear} · acumulado comparable</span><strong><PeriodAmount period={data.previous} label={`Acumulado ${data.previousYear}`} /></strong><small>1 ene al {date(data.previous.to)}</small></div>
      <div><span>{data.year} · acumulado</span><strong><PeriodAmount period={data.current} label={`Acumulado ${data.year}`} /></strong><small>1 ene al {date(data.current.to)}</small></div>
      <div className={tone(data.growth)}><span>Crecimiento acumulado</span><strong>{growth(data.growth)}</strong><small>{data.difference === null ? "Faltan datos comparables" : `${data.difference > 0 ? "+" : ""}${money(data.difference)} frente al mismo corte`}</small></div>
    </div>
    <div className="sales-comparison-chart-scroll" tabIndex={0} role="region" aria-label="Gráfico mensual de ventas"><div className="sales-comparison-chart">
      <canvas ref={canvas} role="img" aria-label={`Ventas netas mensuales ${data.previousYear} y ${data.year}. Importes y variaciones en Detalle mensual.`} />
    </div></div>
    <ul className="sales-comparison-legend" aria-label="Años comparados"><li><i className="prior" />{data.previousYear}</li><li><i className="current" />{data.year}</li></ul>
    <p className="sales-comparison-note">{partial ? `* ${partial.label}: ambos años hasta el día ${Number(data.asOf.slice(8))}. ` : ""}El crecimiento compara el mismo período; no compara un año incompleto con todo el anterior.</p>
    <details className="sales-comparison-detail">
      <summary><span>Detalle mensual y crecimiento</span><ChevronDown size={18} /></summary>
      <div className="sales-comparison-table-scroll" tabIndex={0} role="region" aria-label="Detalle mensual de ventas">
        <table>
          <thead><tr><th scope="col">Mes</th><th scope="col">{data.previousYear}</th><th scope="col">{data.year}</th><th scope="col">Variación CLP</th><th scope="col">Crecimiento</th></tr></thead>
          <tbody>{data.monthly.map(month => <tr key={month.period}>
            <th scope="row">{month.label}{month.partial && <small>Al día {Number(data.asOf.slice(8))}</small>}</th>
            <td><PeriodAmount period={month.previous} label={`${month.label} ${data.previousYear}`} />{month.partial && <small>Mes completo: <PeriodAmount period={month.previousFull} label={`${month.label} ${data.previousYear} completo`} /></small>}</td>
            <td>{month.current ? <PeriodAmount period={month.current} label={`${month.label} ${data.year}`} /> : "No transcurrido"}</td>
            <td className={tone(month.difference)}>{month.difference === null ? "No comparable" : `${month.difference > 0 ? "+" : ""}${money(month.difference)}`}</td>
            <td className={tone(month.growth)}>{month.elapsed ? growth(month.growth) : "No transcurrido"}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
    <p className="sales-comparison-note">Fuente: documentos validados del CRM. Sin documentos no confirma ausencia de ventas. Esta comparación no incluye regularizaciones del Libro Mayor.</p>
  </section>;
}
