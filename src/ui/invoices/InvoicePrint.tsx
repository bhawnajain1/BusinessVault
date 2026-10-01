import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { db } from '../../db';
import type { Business, Customer, Invoice, InvoiceLine, Item, Payment } from '../../db/types';
import Money from '../components/Money';
import Qty from '../components/Qty';
import { loadLogoBlob, loadSignatureBlob } from '../../domain/BusinessProfileService';
import { getCustomerDueForInvoice, type CustomerInvoiceDue } from '../../domain/partyLedger';
import { log } from '../../lib/log';
import { uploadInvoicePdf } from '../../domain/invoiceShare';
import { buildInvoiceWhatsAppUrl } from '../../domain/whatsAppInvoice';

interface Loaded {
  business: Business | null;
  invoice: Invoice;
  lines: InvoiceLine[];
  customer: Customer | undefined;
  items: Map<string, Item>;
  // Resolved via invoice.signature_attachment_id (NOT business.signature_ref)
  // so historical invoices keep the exact image bytes that were current when
  // they were issued. Null if the invoice never captured a signature, or if
  // the blob is missing (Drive-only, not yet hydrated).
  signatureBlobUrl: string | null;
  logoBlobUrl: string | null;
  paymentMethods: string[];
  due: CustomerInvoiceDue;
}

function paymentMethodLabel(method: Payment['method']): string {
  return method === 'upi' ? 'UPI' : method === 'card' ? 'Card' : method === 'cash' ? 'Cash' : 'Credit';
}

function formatDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-IN');
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
  const [searchParams] = useSearchParams();
  const invoiceElement = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sharingPdf, setSharingPdf] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    const createdBlobUrls: string[] = [];
    let cancelled = false;
    (async () => {
      try {
        if (!id) return;
        const invoice = await db.invoices.get(id);
        if (!invoice) throw new Error(`Invoice not found: ${id}`);
        const [lines, customer, business, payments] = await Promise.all([
          db.invoice_lines.where('invoice_id').equals(id).sortBy('line_no'),
          db.customers.get(invoice.customer_id),
          db.businesses.get(invoice.business_id),
          db.payments.where('business_id').equals(invoice.business_id).toArray(),
        ]);
        const items = new Map<string, Item>();
        for (const iid of Array.from(new Set(lines.map((l) => l.item_id)))) {
          const it = await db.items.get(iid);
          if (it) items.set(iid, it);
        }
        // Historical snapshot resolution — the invoice pinned its signature
        // to a specific Attachment at creation time. If that pin exists,
        // load it. If it's null (invoice pre-dates §2, or the business had
        // the toggle off), skip the image and render the plain block.
        const [sigBlob, logoBlob] = await Promise.all([
          loadSignatureBlob(invoice.signature_attachment_id ?? null, db),
          loadLogoBlob(business?.logo_ref, db),
        ]);
        const due = await getCustomerDueForInvoice(id, db);
        let signatureBlobUrl: string | null = null;
        if (sigBlob) {
          signatureBlobUrl = URL.createObjectURL(sigBlob);
          createdBlobUrls.push(signatureBlobUrl);
        }
        let logoBlobUrl: string | null = null;
        if (logoBlob) {
          logoBlobUrl = URL.createObjectURL(logoBlob);
          createdBlobUrls.push(logoBlobUrl);
        }
        log.info('invoice-print', 'signature resolved', {
          invoiceId: invoice.id,
          signatureAttachmentId: invoice.signature_attachment_id ?? null,
          renderingImage: !!signatureBlobUrl,
        });
        const paymentMethods = payments
          .filter((payment) => payment.allocations.some((allocation) => allocation.invoice_id === id))
          .map((payment) => paymentMethodLabel(payment.method));
        if (cancelled) {
          createdBlobUrls.forEach((url) => URL.revokeObjectURL(url));
          return;
        }
        setData({
          business: business ?? null,
          invoice,
          lines,
          customer,
          items,
          signatureBlobUrl,
          logoBlobUrl,
          paymentMethods: Array.from(new Set(paymentMethods)),
          due,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
       createdBlobUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [id]);

  if (error) return <div className="p-6 text-rose-600">{error}</div>;
  if (!data) return <div className="p-6 text-slate-500">Loading...</div>;
  const { business, invoice, lines, customer, items, signatureBlobUrl, logoBlobUrl, paymentMethods, due } = data;
  const isIntrastate = invoice.is_interstate === 0;
  const taxRows = Array.from(
    lines.reduce((rows, line) => {
      const key = `${line.hsn}|${line.tax_rate_bps}`;
      const row = rows.get(key) ?? {
        hsn: line.hsn || '—', taxable: 0, rate: line.tax_rate_bps,
        cgst: 0, sgst: 0, igst: 0,
      };
      row.taxable += line.taxable_paise;
      row.cgst += line.cgst_paise;
      row.sgst += line.sgst_paise;
      row.igst += line.igst_paise;
      rows.set(key, row);
      return rows;
    }, new Map<string, { hsn: string; taxable: number; rate: number; cgst: number; sgst: number; igst: number }>()).values(),
  );
  const totalTax = invoice.cgst_paise + invoice.sgst_paise + invoice.igst_paise;
  const totalQty = lines.reduce((sum, line) => sum + line.qty_micros, 0);

  async function sharePdfViaWhatsApp() {
    const element = invoiceElement.current;
    if (!element) return;
    // Open synchronously from the click so popup blockers allow the later
    // navigation after PDF rendering and upload have completed.
    const popup = window.open('', '_blank');
    if (!popup) {
      setShareError('Your browser blocked WhatsApp. Allow popups for BusinessVault and try again.');
      return;
    }
    setShareError(null);
    setSharingPdf(true);
    try {
      // html2canvas renders screen CSS, not @media print. Capture a dedicated
      // A4-width clone with the same dimensions and typography as print.
      const capture = document.createElement('div');
      capture.className = 'invoice-print-root invoice-pdf-capture';
      capture.append(element.cloneNode(true));
      document.body.append(capture);
      let canvas: HTMLCanvasElement;
      try {
        canvas = await html2canvas(capture, {
          backgroundColor: '#ffffff',
          scale: 2,
          useCORS: true,
        });
      } finally {
        capture.remove();
      }
      const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
      const printableWidthMm = 190;
      const printableHeightMm = 277;
      const sourcePageHeight = Math.floor(canvas.width * (printableHeightMm / printableWidthMm));
      for (let top = 0, page = 0; top < canvas.height; top += sourcePageHeight, page += 1) {
        if (page > 0) pdf.addPage();
        const height = Math.min(sourcePageHeight, canvas.height - top);
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvas.width;
        pageCanvas.height = height;
        const context = pageCanvas.getContext('2d');
        if (!context) throw new Error('Could not prepare invoice PDF page.');
        context.drawImage(canvas, 0, top, canvas.width, height, 0, 0, canvas.width, height);
        const heightMm = (height * printableWidthMm) / canvas.width;
        pdf.addImage(pageCanvas.toDataURL('image/png'), 'PNG', 10, 10, printableWidthMm, heightMm);
      }
      const pdfUrl = await uploadInvoicePdf(invoice, pdf.output('blob'));
      const whatsAppUrl = buildInvoiceWhatsAppUrl({ business, customer, invoice, pdfUrl });
      if (!whatsAppUrl) throw new Error('Add a valid customer mobile number before sending on WhatsApp.');
      popup.location.href = whatsAppUrl;
    } catch (e) {
      popup.close();
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setShareError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSharingPdf(false);
    }
  }

  return (
    <>
      <style>{`
        .invoice-print-root { font-family: Arial, Helvetica, sans-serif; color: #303442; }
        .invoice-print-root table { border-collapse: collapse; width: 100%; }
        .invoice-print-root th, .invoice-print-root td { border: 1px solid #3d414d; padding: 4px 6px; vertical-align: top; }
        .invoice-print-root th { background: #f3f4f6; font-weight: 700; }
        .invoice-print-root .section-title { background: #f3f4f6; font-weight: 700; padding: 5px 7px; border-bottom: 1px solid #3d414d; }
        .invoice-print-root .muted { color: #5f6470; }
        .invoice-print-root .right { text-align: right; }
        .invoice-print-root .center { text-align: center; }
        .invoice-print-root .nowrap { white-space: nowrap; }
         .invoice-print-root .keep-together { break-inside: avoid; page-break-inside: avoid; }
         .invoice-pdf-capture {
           position: fixed;
           left: -10000px;
           top: 0;
           width: 190mm;
           margin: 0;
           padding: 0;
           background: #fff;
           font-size: 10px;
         }
         .invoice-pdf-capture table { font-size: 9px; }
         .invoice-pdf-capture th, .invoice-pdf-capture td { padding: 3px 4px; }
        @media print {
          .no-print { display: none !important; }
          @page { size: A4; margin: 10mm; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          /* Force the invoice to use the full page width and shrink the type
             so all 10 columns of the line-item table (incl. RHS Total) fit
             inside the printable area on A4. Without these overrides the
             10-col grid overflows the right margin and gets clipped. */
          .invoice-print-root { max-width: none !important; margin: 0 !important; padding: 0 !important; font-size: 11px !important; }
           .invoice-print-root { width: 100%; font-size: 10px !important; }
           .invoice-print-root table { font-size: 9px !important; }
           .invoice-print-root th, .invoice-print-root td { padding: 3px 4px; }
           .invoice-print-root .screen-only { display: none !important; }
        }
      `}</style>

      <div className="invoice-print-root max-w-4xl mx-auto p-4 bg-white">
        <div className="no-print screen-only flex items-center justify-between mb-4">
          <Link
            to={`/invoices/${invoice.id}`}
            className="text-sm text-blue-700 hover:underline"
          >
            ← Back to invoice
          </Link>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={sharePdfViaWhatsApp}
              disabled={sharingPdf}
              className="border border-green-700 text-green-800 text-sm rounded px-3 py-1.5 hover:bg-green-50 disabled:opacity-50"
            >
              {sharingPdf ? 'Preparing invoice link...' : 'Send Invoice on WhatsApp'}
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 hover:bg-slate-800"
            >
              Print / Save PDF
            </button>
          </div>
        </div>
        {searchParams.get('share') === 'pdf' && (
          <div className="no-print mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-900">
            Invoice saved. Tap <strong>Send Invoice on WhatsApp</strong> to open the customer's chat with a secure PDF link.
          </div>
        )}
        {shareError && <div className="no-print mb-4 text-sm text-rose-600">{shareError}</div>}

        <div ref={invoiceElement} className="border border-[#3d414d]">
          <div className="center border-b border-[#3d414d] py-2 text-lg font-bold">Tax Invoice</div>
          <div className="grid grid-cols-[140px_1fr_260px] gap-3 border-b border-[#3d414d] p-2 keep-together">
            <div className="flex items-center justify-center">
              {logoBlobUrl ? <img src={logoBlobUrl} alt="Company logo" className="max-h-28 max-w-32 object-contain" /> : <div className="h-24 w-28" aria-hidden="true" />}
            </div>
            <div className="leading-5">
              <div className="text-xl font-bold uppercase">{business?.legal_name || business?.name || 'Business'}</div>
              <div>{[business?.address_line1, business?.address_line2, business?.city, business?.pincode].filter(Boolean).join(', ')}</div>
              {business?.phone && <div>Phone: {business.phone}</div>}
              {business?.state && <div>State: {business.state_code ? `${business.state_code}-` : ''}{business.state}</div>}
            </div>
            <div className="leading-5">
              {business?.gstin && <div><strong>GSTIN:</strong> {business.gstin}</div>}
              {business?.udyamRegistrationNumber && <div><strong>Udyam Registration Number:</strong> {business.udyamRegistrationNumber}</div>}
              {business?.pan && <div><strong>PAN:</strong> {business.pan}</div>}
            </div>
          </div>

          <table className="keep-together">
            <thead><tr><th colSpan={2} className="text-left">Bill To:</th><th colSpan={2} className="text-left">Invoice Details:</th></tr></thead>
            <tbody><tr>
              <td colSpan={2} className="leading-5">
                <strong>{customer?.name || 'Walk-in Customer'}</strong><br />
                {customer?.billing_address && <>{customer.billing_address}<br /></>}
                {customer?.phone && <>Contact No: {customer.phone}<br /></>}
                {customer?.gstin && <>GSTIN: {customer.gstin}<br /></>}
                {customer?.state && <>State: {customer.state_code ? `${customer.state_code}-` : ''}{customer.state}</>}
              </td>
              <td colSpan={2} className="leading-5">
                <div><strong>Invoice No.:</strong> {invoice.invoice_number}</div>
                <div><strong>Date:</strong> {formatDate(invoice.invoice_date)}</div>
                <div><strong>Time:</strong> {formatBillDateTime('', invoice.created_at).replace(' · ', '')}</div>
                {invoice.due_date && <div><strong>Due Date:</strong> {formatDate(invoice.due_date)}</div>}
                <div><strong>Place of Supply:</strong> {invoice.place_of_supply}{invoice.customer_state_code ? ` (${invoice.customer_state_code})` : ''}</div>
              </td>
            </tr></tbody>
          </table>

          <table className="mt-3">
            <thead><tr><th>#</th><th className="text-left">Item name</th><th className="text-left">HSN / SAC</th><th className="right">Quantity</th><th>Unit</th><th className="right">Price / Unit (₹)</th><th className="right">GST (₹)</th><th className="right">Amount (₹)</th></tr></thead>
            <tbody>
              {lines.map((line) => <tr key={line.id}>
                <td className="center">{line.line_no}</td>
                <td><strong>{items.get(line.item_id)?.name ?? line.item_id}</strong>{line.description && <div className="muted">{line.description}</div>}</td>
                <td>{line.hsn || '—'}</td>
                <td className="right"><Qty micros={line.qty_micros} /></td>
                <td className="center">{items.get(line.item_id)?.unit_id || '—'}</td>
                <td className="right"><Money paise={line.unit_price_paise} /></td>
                <td className="right"><Money paise={line.cgst_paise + line.sgst_paise + line.igst_paise + line.cess_paise} /></td>
                <td className="right"><Money paise={line.line_total_paise} /></td>
              </tr>)}
              <tr><td /><td><strong>Total</strong></td><td /><td className="right"><strong><Qty micros={totalQty} /></strong></td><td /><td /><td className="right"><strong><Money paise={totalTax + invoice.cess_paise} /></strong></td><td className="right"><strong><Money paise={invoice.pre_round_total_paise} /></strong></td></tr>
            </tbody>
          </table>

          <div className="grid grid-cols-[1.6fr_1fr] mt-3 keep-together">
            <div>
              <div className="section-title">Tax Summary:</div>
              <table><thead><tr><th>HSN / SAC</th><th>Taxable Amount (₹)</th>{isIntrastate ? <><th>CGST Rate (%)</th><th>CGST Amount (₹)</th><th>SGST Rate (%)</th><th>SGST Amount (₹)</th></> : <><th>IGST Rate (%)</th><th>IGST Amount (₹)</th></>}<th>Total Tax (₹)</th></tr></thead>
                <tbody>{taxRows.map((row) => <tr key={`${row.hsn}-${row.rate}`}><td>{row.hsn}</td><td className="right"><Money paise={row.taxable} /></td>{isIntrastate ? <><td className="right">{(row.rate / 200).toFixed(2)}</td><td className="right"><Money paise={row.cgst} /></td><td className="right">{(row.rate / 200).toFixed(2)}</td><td className="right"><Money paise={row.sgst} /></td></> : <><td className="right">{(row.rate / 100).toFixed(2)}</td><td className="right"><Money paise={row.igst} /></td></>}<td className="right"><Money paise={row.cgst + row.sgst + row.igst} /></td></tr>)}<tr><td><strong>TOTAL</strong></td><td className="right"><strong><Money paise={invoice.taxable_paise} /></strong></td>{isIntrastate ? <><td /><td className="right"><strong><Money paise={invoice.cgst_paise} /></strong></td><td /><td className="right"><strong><Money paise={invoice.sgst_paise} /></strong></td></> : <><td /><td className="right"><strong><Money paise={invoice.igst_paise} /></strong></td></>}<td className="right"><strong><Money paise={totalTax} /></strong></td></tr></tbody>
              </table>
              {paymentMethods.length > 0 && <><div className="section-title mt-3">Payment Mode:</div><div className="border border-t-0 border-[#3d414d] p-2">{paymentMethods.join(', ')}</div></>}
            </div>
            <div>
              <table><tbody>
                <tr><td>Sub Total</td><td className="right"><Money paise={invoice.subtotal_paise} /></td></tr>
                {invoice.discount_paise !== 0 && <tr><td>Discount</td><td className="right"><Money paise={-invoice.discount_paise} /></td></tr>}
                <tr><td>Round Off</td><td className="right"><Money paise={invoice.round_off_paise} /></td></tr>
                <tr><td><strong>Total</strong></td><td className="right"><strong><Money paise={invoice.total_paise} /></strong></td></tr>
              </tbody></table>
              <div className="section-title">Invoice Amount in Words:</div><div className="border border-t-0 p-2 break-words">{amountInWords(invoice.total_paise)}</div>
              <div className="flex justify-between border-x border-b border-[#3d414d] p-2"><span>Received</span><Money paise={due.received_paise} /></div>
              <div className="flex justify-between border-x border-b border-[#3d414d] p-2"><span>Balance</span><Money paise={due.balance_paise} /></div>
              <div className="flex justify-between border-x border-b border-[#3d414d] p-2"><span>Previous Due</span><Money paise={due.previous_due_paise} /></div>
              <div className="flex justify-between border-x border-b border-[#3d414d] p-2 font-bold"><span>Total Due</span><Money paise={due.total_due_paise} /></div>
            </div>
          </div>

          {(invoice.terms || invoice.notes) && <div className="mt-3 keep-together"><div className="section-title">Terms &amp; Conditions</div><div className="border border-t-0 p-2 whitespace-pre-wrap break-words">{invoice.terms || invoice.notes}</div></div>}
          <div className="grid grid-cols-2 mt-3 keep-together">
            <div />
            <div className="border border-[#3d414d] min-h-32 p-2 text-center"><strong>For {business?.legal_name || business?.name || 'Business'}:</strong><div className="h-20 flex items-center justify-center">{signatureBlobUrl && <img src={signatureBlobUrl} alt="Authorised signature" className="max-h-16 max-w-48 object-contain" />}</div><div className="border-t border-[#3d414d] pt-1">Authorized Signatory</div></div>
          </div>
        </div>
      </div>
    </>
  );
}
