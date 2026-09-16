import { useEffect, useRef } from "react";
import {
  Chart,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Legend,
  Tooltip,
} from "chart.js";
import type { CopilotComponent } from "../../lib/copilotCentralApi";

Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Legend,
  Tooltip,
);
const colors = ["#098796", "#c36d58", "#687f32", "#7667a0"];
const classification = {
  fact: "Hecho registrado",
  calculation: "Calculo",
  estimate: "Estimacion",
};
const format = (value: number | null, unit: string) =>
  value === null || !Number.isFinite(value)
    ? "No disponible"
    : unit === "percent"
      ? `${value.toLocaleString("es-CL", { maximumFractionDigits: 1 })}%`
      : unit === "CLP"
        ? new Intl.NumberFormat("es-CL", {
            style: "currency",
            currency: "CLP",
            maximumFractionDigits: 0,
          }).format(value)
        : `${value.toLocaleString("es-CL")} ${unit}`;

function BusinessChart({
  component,
}: {
  component: Extract<CopilotComponent, { type: "chart" }>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const chart = new Chart(canvas.current, {
      type: component.chartType === "bar" ? "bar" : "line",
      data: {
        labels: component.labels.slice(0, 60),
        datasets: component.series.slice(0, 6).map((series, i) => ({
          label: series.name,
          data: series.values
            .slice(0, 60)
            .map((v) => (v === null || !Number.isFinite(v) ? null : v)),
          borderColor: colors[i % colors.length],
          backgroundColor: colors[i % colors.length],
          borderWidth: 2,
          pointRadius: 3,
          spanGaps: false,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "bottom",
            labels: { boxWidth: 12, usePointStyle: true },
          },
          tooltip: {
            callbacks: {
              label: (c) =>
                `${c.dataset.label}: ${format(c.parsed.y, component.unit)}`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { maxRotation: 40, autoSkip: true, maxTicksLimit: 12 },
          },
          y: {
            beginAtZero: true,
            ticks: {
              callback: (v) =>
                new Intl.NumberFormat("es-CL", {
                  notation: "compact",
                  maximumFractionDigits: 1,
                }).format(Number(v)),
            },
            grid: { color: "#e5ecee" },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [component]);
  return (
    <figure className="cc-chart">
      <figcaption>
        <strong>{component.title}</strong>
        <small>
          {classification[component.classification]} · {component.unit}
        </small>
      </figcaption>
      <div className="cc-chart-canvas">
        <canvas ref={canvas} role="img" aria-label={component.title} />
      </div>
      <details>
        <summary>Datos del grafico</summary>
        <div className="cc-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Periodo / indicador</th>
                {component.series.map((s, i) => (
                  <th key={i}>{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {component.labels.map((label, i) => (
                <tr key={i}>
                  <th>{label}</th>
                  {component.series.map((s, j) => (
                    <td key={j}>
                      {format(s.values[i] ?? null, component.unit)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
export function BusinessVisuals({
  components,
}: {
  components: CopilotComponent[];
}) {
  const kpis = components.filter(
    (c): c is Extract<CopilotComponent, { type: "kpi" }> => c.type === "kpi",
  );
  return (
    <>
      {!!kpis.length && (
        <dl className="cc-kpis cc-business-kpis">
          {kpis.map((c, i) => (
            <div key={i}>
              <dt>{c.title}</dt>
              <dd>{format(c.value, c.unit)}</dd>
              <small>{classification[c.classification]}</small>
            </div>
          ))}
        </dl>
      )}
      {components
        .filter(
          (c): c is Extract<CopilotComponent, { type: "chart" }> =>
            c.type === "chart",
        )
        .map((c, i) => (
          <BusinessChart key={i} component={c} />
        ))}
    </>
  );
}
