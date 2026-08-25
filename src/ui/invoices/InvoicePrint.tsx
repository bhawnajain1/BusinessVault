import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { db } from '../../db';
import type { Business, Customer, Invoice, InvoiceLine, Item } from '../../db/types';
import Money from '../components/Money';
import Qty from '../components/Qty';

interface Loaded {
  business: Business | null;
  invoice: Invoice;
  lines: InvoiceLine[];
  customer: Customer | undefined;
  items: Map<string, Item>;
}

// Indian numbering system amount-to-words. Handles up to 99,99,99,999 (99 crore).
const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigit(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o === 0 ? TENS[t] : `${TENS[t]} ${ONES[o]}`;
}

function threeDigit(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${ONES[h]} Hundred`);
  if (rest > 0) parts.push(twoDigit(rest));
  return parts.join(' ');
}

function inr(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${twoDigit(crore)} Crore`);
  if (lakh) parts.push(`${twoDigit(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigit(thousand)} Thousand`);
  if (rest) parts.push(threeDigit(rest));
  return parts.join(' ');
}

// Render `<invoice_date> <local 12h time>` using created_at for the time
// portion, since the schema stores date as YYYY-MM-DD only.
export function formatBillDateTime(invoiceDate: string, createdAt: string): string {
  const t = new Date(createdAt);
  if (Number.isNaN(t.getTime())) return invoiceDate;
  const time = t.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${invoiceDate} · ${time}`;
}

export function amountInWords(totalPaise: number): string {
  const abs = Math.abs(totalPaise);
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  const sign = totalPaise < 0 ? 'Negative ' : '';
  const rupeeWords = inr(rupees);
  if (paise === 0) return `${sign}Rupees ${rupeeWords} Only`;
  return `${sign}Rupees ${rupeeWords} and ${twoDigit(paise)} Paise Only`;
}

export default function InvoicePrint() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        if (!id) return;
        const invoice = await db.invoices.get(id);
        if (!invoice) throw new Error(`Invoice not found: ${id}`);
        const [lines, customer, business] = await Promise.all([
          db.invoice_lines.where('invoice_id').equals(id).sortBy('line_no'),
          db.customers.get(invoice.customer_id),
          db.businesses.get(invoice.business_id),
        ]);
        const items = new Map<string, Item>();
        for (const iid of Array.from(new Set(lines.map((l) => l.item_id)))) {
          const it = await db.items.get(iid);
          if (it) items.set(iid, it);
        }
        setData({
          business: business ?? null,
          invoice,
          lines,
          customer,
          items,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [id]);

  if (error) return <div className="p-6 text-rose-600">{error}</div>;
  if (!data) return <div className="p-6 text-slate-500">Loading...</div>;
  const { business, invoice, lines, customer, items } = data;
  const isIntrastate = invoice.is_interstate === 0;

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { size: A4; margin: 10mm; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          /* Force the invoice to use the full page width and shrink the type
             so all 10 columns of the line-item table (incl. RHS Total) fit
             inside the printable area on A4. Without these overrides the
             10-col grid overflows the right margin and gets clipped. */
          .invoice-print-root { max-width: none !important; margin: 0 !important; padding: 0 !important; font-size: 11px !important; }
          .invoice-print-root table { font-size: 10px !important; }
        }
      `}</style>

      <div className="invoice-print-root max-w-4xl mx-auto p-6 bg-white text-slate-900">
        <div className="no-print flex items-center justify-between mb-4">
          <Link
            to={`/invoices/${invoice.id}`}
            className="text-sm text-blue-700 hover:underline"
          >
            ← Back to invoice
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 hover:bg-slate-800"
          >
            Print / Save PDF
          </button>
        </div>

        <div className="border border-slate-800 p-4">
          <div className="text-center border-b border-slate-800 pb-2 mb-3">
            <div className="text-lg font-bold uppercase tracking-wide">Tax Invoice</div>
            <div className="text-xs text-slate-600">(ORIGINAL FOR RECIPIENT)</div>
          </div>

          {/* Seller + Invoice meta */}
          <div className="grid grid-cols-2 gap-4 border-b border-slate-800 pb-3">
            <div>
              <div className="font-semibold text-base">
                {business?.legal_name || business?.name || '(Business name not set)'}
              </div>
              {business?.address_line1 && (
                <div className="text-sm">{business.address_line1}</div>
              )}
              {business?.address_line2 && (
                <div className="text-sm">{business.address_line2}</div>
              )}
              {(business?.city || business?.pincode) && (
                <div className="text-sm">
                  {[business.city, business.pincode].filter(Boolean).join(' - ')}
                </div>
              )}
              {business?.state && (
                <div className="text-sm">
                  {business.state}
                  {business.state_code ? ` (${business.state_code})` : ''}
                </div>
              )}
              {business?.gstin && (
                <div className="text-sm font-mono">GSTIN: {business.gstin}</div>
              )}
              {business?.pan && <div className="text-sm font-mono">PAN: {business.pan}</div>}
              {business?.phone && <div className="text-sm">Phone: {business.phone}</div>}
              {business?.email && <div className="text-sm">Email: {business.email}</div>}
            </div>
            <div className="text-sm">
              <table className="w-full">
                <tbody>
                  <tr>
                    <td className="text-slate-600">Invoice #</td>
                    <td className="text-right font-semibold">{invoice.invoice_number}</td>
                  </tr>
                  <tr>
                    <td className="text-slate-600">Invoice Date</td>
                    <td className="text-right">{formatBillDateTime(invoice.invoice_date, invoice.created_at)}</td>
                  </tr>
                  {invoice.due_date && (
                    <tr>
                      <td className="text-slate-600">Due Date</td>
                      <td className="text-right">{invoice.due_date}</td>
                    </tr>
                  )}
                  <tr>
                    <td className="text-slate-600">Financial Year</td>
                    <td className="text-right">{invoice.financial_year}</td>
                  </tr>
                  <tr>
                    <td className="text-slate-600">Place of Supply</td>
                    <td className="text-right">
                      {invoice.place_of_supply} ({invoice.customer_state_code})
                    </td>
                  </tr>
                  <tr>
                    <td className="text-slate-600">Supply Type</td>
                    <td className="text-right">
                      {isIntrastate ? 'Intrastate' : 'Interstate'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Buyer block */}
          <div className="grid grid-cols-2 gap-4 border-b border-slate-800 py-3">
            <div>
              <div className="text-xs uppercase text-slate-500 mb-1">Bill To</div>
              <div className="font-semibold">
                {customer?.name || 'Walk-in Customer'}
              </div>
              {customer?.billing_address && (
                <div className="text-sm whitespace-pre-wrap">{customer.billing_address}</div>
              )}
              {customer?.state && (
                <div className="text-sm">
                  {customer.state}
                  {customer.state_code ? ` (${customer.state_code})` : ''}
                </div>
              )}
              {customer?.gstin && (
                <div className="text-sm font-mono">GSTIN: {customer.gstin}</div>
              )}
              {customer?.phone && <div className="text-sm">Phone: {customer.phone}</div>}
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500 mb-1">Ship To</div>
              {customer?.shipping_address ? (
                <div className="text-sm whitespace-pre-wrap">{customer.shipping_address}</div>
              ) : (
                <div className="text-sm text-slate-500">(same as billing)</div>
              )}
            </div>
          </div>

          {/* Line items */}
          <table className="w-full text-sm border-b border-slate-800 mt-3">
            <thead>
              <tr className="border-b border-slate-800 text-xs uppercase text-slate-600">
                <th className="text-left py-1">#</th>
                <th className="text-left py-1">Description</th>
                <th className="text-left py-1">HSN</th>
                <th className="text-right py-1">Qty</th>
                <th className="text-right py-1">Rate</th>
                <th className="text-right py-1">Taxable</th>
                {isIntrastate ? (
                  <>
                    <th className="text-right py-1">
                      CGST
                      <br />
                      <span className="text-[10px]">%/Amt</span>
                    </th>
                    <th className="text-right py-1">
                      SGST
                      <br />
                      <span className="text-[10px]">%/Amt</span>
                    </th>
                  </>
                ) : (
                  <th className="text-right py-1">
                    IGST
                    <br />
                    <span className="text-[10px]">%/Amt</span>
                  </th>
                )}
                <th className="text-right py-1">Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const gstPct = (l.tax_rate_bps / 100).toFixed(l.tax_rate_bps % 100 ? 2 : 0);
                const halfPct = (l.tax_rate_bps / 200).toFixed(l.tax_rate_bps % 200 ? 2 : 0);
                return (
                  <tr key={l.id} className="border-b border-slate-200 align-top">
                    <td className="py-1">{l.line_no}</td>
                    <td className="py-1">
                      <div>{items.get(l.item_id)?.name ?? l.item_id}</div>
                      {l.description && (
                        <div className="text-xs text-slate-500">{l.description}</div>
                      )}
                    </td>
                    <td className="py-1">{l.hsn}</td>
                    <td className="py-1 text-right">
                      <Qty micros={l.qty_micros} />
                    </td>
                    <td className="py-1 text-right">
                      <Money paise={l.unit_price_paise} />
                    </td>
                    <td className="py-1 text-right">
                      <Money paise={l.taxable_paise} />
                    </td>
                    {isIntrastate ? (
                      <>
                        <td className="py-1 text-right">
                          <div className="text-[10px]">{halfPct}%</div>
                          <Money paise={l.cgst_paise} />
                        </td>
                        <td className="py-1 text-right">
                          <div className="text-[10px]">{halfPct}%</div>
                          <Money paise={l.sgst_paise} />
                        </td>
                      </>
                    ) : (
                      <td className="py-1 text-right">
                        <div className="text-[10px]">{gstPct}%</div>
                        <Money paise={l.igst_paise} />
                      </td>
                    )}
                    <td className="py-1 text-right">
                      <Money paise={l.line_total_paise} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Totals */}
          <div className="grid grid-cols-2 gap-4 mt-3">
            <div className="text-sm">
              <div className="text-xs uppercase text-slate-500 mb-1">Amount in words</div>
              <div className="italic">{amountInWords(invoice.total_paise)}</div>
              {invoice.notes && (
                <div className="mt-3">
                  <div className="text-xs uppercase text-slate-500 mb-1">Notes</div>
                  <div className="whitespace-pre-wrap">{invoice.notes}</div>
                </div>
              )}
              {invoice.terms && (
                <div className="mt-3">
                  <div className="text-xs uppercase text-slate-500 mb-1">Terms</div>
                  <div className="whitespace-pre-wrap">{invoice.terms}</div>
                </div>
              )}
            </div>
            <div className="text-sm">
              <table className="w-full">
                <tbody>
                  <tr>
                    <td className="text-slate-600">Subtotal</td>
                    <td className="text-right">
                      <Money paise={invoice.subtotal_paise} />
                    </td>
                  </tr>
                  {invoice.discount_paise !== 0 && (
                    <tr>
                      <td className="text-slate-600">Discount</td>
                      <td className="text-right">
                        - <Money paise={invoice.discount_paise} />
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td className="text-slate-600">Taxable Value</td>
                    <td className="text-right">
                      <Money paise={invoice.taxable_paise} />
                    </td>
                  </tr>
                  {invoice.cgst_paise !== 0 && (
                    <tr>
                      <td className="text-slate-600">CGST</td>
                      <td className="text-right">
                        <Money paise={invoice.cgst_paise} />
                      </td>
                    </tr>
                  )}
                  {invoice.sgst_paise !== 0 && (
                    <tr>
                      <td className="text-slate-600">SGST</td>
                      <td className="text-right">
                        <Money paise={invoice.sgst_paise} />
                      </td>
                    </tr>
                  )}
                  {invoice.igst_paise !== 0 && (
                    <tr>
                      <td className="text-slate-600">IGST</td>
                      <td className="text-right">
                        <Money paise={invoice.igst_paise} />
                      </td>
                    </tr>
                  )}
                  {invoice.cess_paise !== 0 && (
                    <tr>
                      <td className="text-slate-600">Cess</td>
                      <td className="text-right">
                        <Money paise={invoice.cess_paise} />
                      </td>
                    </tr>
                  )}
                  {invoice.round_off_paise !== 0 && (
                    <tr>
                      <td className="text-slate-600">Round Off</td>
                      <td className="text-right">
                        <Money paise={invoice.round_off_paise} />
                      </td>
                    </tr>
                  )}
                  <tr className="border-t border-slate-800 font-semibold">
                    <td className="pt-1">Grand Total</td>
                    <td className="text-right pt-1">
                      <Money paise={invoice.total_paise} />
                    </td>
                  </tr>
                  {invoice.paid_paise !== 0 && (
                    <tr>
                      <td className="text-slate-600">Paid</td>
                      <td className="text-right">
                        <Money paise={invoice.paid_paise} />
                      </td>
                    </tr>
                  )}
                  {invoice.balance_paise !== 0 && (
                    <tr className="font-semibold">
                      <td>Balance Due</td>
                      <td className="text-right">
                        <Money paise={invoice.balance_paise} />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Signature block */}
          <div className="grid grid-cols-2 gap-4 mt-8 pt-3 border-t border-slate-800">
            <div className="text-xs text-slate-600">
              This is a computer-generated invoice and does not require a physical signature.
            </div>
            <div className="text-right text-sm">
              <div className="mb-10">
                For <strong>{business?.legal_name || business?.name || '—'}</strong>
              </div>
              <div className="border-t border-slate-400 pt-1 inline-block min-w-[180px]">
                Authorised Signatory
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
