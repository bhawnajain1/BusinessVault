import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { gstMonthlyReportService } from '../../../domain/gstReporting';
import { money, toDateString } from '../reportUtils';
import { log } from '../../../lib/log';

// Taxable sales vs taxable purchases, one pair of bars per month. Loads its
// own month workings through the same read-only calculateMonths call the page
// uses, so it never changes how GST is calculated. Plain HTML/CSS bars, the
// same style as the dashboard Sales & Collections chart.

type View = 'FY' | 'RECENT';
type Point = { key: string; sales: number; purchases: number };

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RECENT_MONTHS = 6;
const inrWhole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

function rupeesWhole(paise: number): string {
  return inrWhole.format(Math.round(paise / 100));
}

function niceCeil(paise: number): number {
  if (paise <= 0) return 100_000_00;
  const rupees = paise / 100;
  const pow = 10 ** Math.floor(Math.log10(rupees));
  const step = [1, 2, 2.5, 5, 10].find(s => s * pow >= rupees) ?? 10;
  return step * pow * 100;
}

function addMonths(key: string, delta: number): string {
  const index = Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
}

// FY view: April–March of the selected year, stopping at the current month
// (future months have no transactions yet). Recent view: the last six months.
export function chartMonths(view: View, financialYear: string, todayMonth: string): string[] {
  if (view === 'RECENT') return Array.from({ length: RECENT_MONTHS }, (_, i) => addMonths(todayMonth, i - RECENT_MONTHS + 1));
  const start = `${financialYear.slice(0, 4)}-04`;
  return Array.from({ length: 12 }, (_, i) => addMonths(start, i)).filter(key => key <= todayMonth);
}

function monthLong(key: string): string {
  return `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
}

type Props = { businessId: string; financialYear: string; frequency: 'MONTHLY' | 'QRMP'; revision: number; ready: boolean };

export default function GstMonthlyChart({ businessId, financialYear, frequency, revision, ready }: Props) {
  const [view, setView] = useState<View>('FY');
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState<number | null>(null);
  const months = chartMonths(view, financialYear, toDateString(new Date()).slice(0, 7));
  const monthsKey = months.join();

  useEffect(() => {
    let alive = true;
    setPoints([]); setError(''); setActive(null);
    if (!ready || !businessId || !months.length) { setLoading(false); return; }
    setLoading(true);
    log.info('gst-reports', 'monthly comparison chart loading', { businessId, view, months });
    gstMonthlyReportService.calculateMonths(businessId, months, frequency).then(results => {
      if (!alive) return;
      setPoints(results.map(r => ({ key: r.period.periodKey, sales: r.totals.outwardNet.taxable_paise, purchases: r.totals.inwardNet.taxable_paise })));
      log.info('gst-reports', 'monthly comparison chart loaded', { businessId, view, count: results.length });
    }).catch((e: unknown) => {
      if (!alive) return;
      setError(e instanceof Error ? e.message : String(e));
      log.info('gst-reports', 'monthly comparison chart failed', { businessId, view, error: String(e) });
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [businessId, ready, monthsKey, frequency, revision]);

  const max = niceCeil(Math.max(0, ...points.flatMap(p => [p.sales, p.purchases])));
  const ticks = [1, 0.75, 0.5, 0.25, 0].map(f => f * max);
  const empty = points.every(p => p.sales === 0 && p.purchases === 0);
  const height = (paise: number) => `${Math.max(0, Math.min(100, paise / max * 100))}%`;
  const viewButton = (value: View, label: string) => <button type="button" aria-pressed={view === value} className={view === value ? 'active' : ''} onClick={() => { setView(value); log.info('gst-reports', 'monthly comparison view changed', { view: value }); }}>{label}</button>;

  return <section className="gst-section-card gst-chart-card" aria-labelledby="gst-chart-heading">
    <div className="gst-card-heading">
      <div><BarChart3 size={22} /><div><h2 id="gst-chart-heading">Monthly comparison</h2><p>Taxable sales vs taxable purchases, each month calculated independently.</p></div></div>
      <div className="gst-chart-toggle" role="group" aria-label="Comparison range">{viewButton('FY', `FY ${financialYear.slice(0, 4)}–${financialYear.slice(-2)}`)}{viewButton('RECENT', `Last ${RECENT_MONTHS} months`)}</div>
    </div>
    <div className="gst-chart-body">
      <div className="gst-chart-legend" aria-hidden="true"><span><i className="gst-bar-sales" />Taxable sales</span><span><i className="gst-bar-purchases" />Taxable purchases</span></div>
      {error ? <p role="alert" className="gst-chart-message">Could not load the monthly comparison: {error}</p>
        : !months.length ? <p className="gst-chart-message">This financial year has not started yet, so there is nothing to compare.</p>
        : <div className="gst-chart-frame">
          <div className="gst-chart-axis" aria-hidden="true">{ticks.map((t, i) => <span key={i} style={{ top: `${i * 25}%` }}>{rupeesWhole(t)}</span>)}<span className="gst-chart-axis-width">{rupeesWhole(max)}</span></div>
          <div className="gst-chart-plot-wrap">
            <div className="gst-chart-plot">
              {ticks.map((_, i) => <div key={i} className={`gst-chart-grid ${i === ticks.length - 1 ? 'base' : ''}`} style={{ top: `${i * 25}%` }} aria-hidden="true" />)}
              {(loading || empty) && <div className="gst-chart-overlay"><p>{loading ? 'Loading monthly comparison…' : 'No taxable sales or purchases in these months'}</p></div>}
              <div className="gst-chart-bars">{points.map((p, i) => {
                const align = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
                return <div key={p.key} tabIndex={0} className={`gst-chart-month ${active === i ? 'active' : ''}`} aria-label={`${monthLong(p.key)}: taxable sales ${money(p.sales)}, taxable purchases ${money(p.purchases)}`}
                  onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}>
                  <span className="gst-bar gst-bar-sales" style={{ height: height(p.sales) }} />
                  <span className="gst-bar gst-bar-purchases" style={{ height: height(p.purchases) }} />
                  {active === i && <div className={`gst-chart-tooltip ${align}`} aria-hidden="true"><strong>{monthLong(p.key)}</strong><span><i className="gst-bar-sales" />Taxable sales<b>{money(p.sales)}</b></span><span><i className="gst-bar-purchases" />Taxable purchases<b>{money(p.purchases)}</b></span></div>}
                </div>;
              })}</div>
            </div>
            <div className="gst-chart-labels" aria-hidden="true">{points.map(p => <span key={p.key}>{MONTH_NAMES[Number(p.key.slice(5, 7)) - 1].slice(0, 3)}{p.key.endsWith('-01') || p.key === points[0]?.key ? ` ’${p.key.slice(2, 4)}` : ''}</span>)}</div>
          </div>
        </div>}
    </div>
  </section>;
}
