import { useEffect } from 'react';
import type { Business, Customer, Invoice, InvoiceLine, Item } from '../../db/types';
import { fromMoney } from '../../domain/money';
import type { Money } from '../../domain/money';

function formatPosDateTime(invoiceDate: string, createdAt: string): string {
  const t = new Date(createdAt);
  if (Number.isNaN(t.getTime())) return invoiceDate;
  const time = t.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${invoiceDate} ${time}`;
}

export interface PrintablePayment {
  method: 'cash' | 'card' | 'upi' | 'credit';
  amount_paise: number;
}

export interface InvoicePrintProps {
  business: Business | null;
  customer: Customer | null;
  invoice: Invoice;
  lines: InvoiceLine[];
  itemsById: Map<string, Item>;
  payments: PrintablePayment[];
  autoPrint?: boolean;
  onAfterPrint?: () => void;
  logoUrl?: string | null;
}

// Thermal 58mm receipt. Printable area is ~48mm wide (32 monospace cols).
// window.print + @media print styles keep the on-screen UI intact.
export default function InvoicePrint(props: InvoicePrintProps): JSX.Element {
  const {
    business,
    customer,
    invoice,
    lines,
    itemsById,
    payments,
    autoPrint,
    onAfterPrint,
  } = props;

  useEffect(() => {
    if (!autoPrint) return;
    const t = window.setTimeout(() => {
      window.print();
      if (onAfterPrint) onAfterPrint();
    }, 30);
    return () => window.clearTimeout(t);
  }, [autoPrint, onAfterPrint]);

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="pos-print-root" role="document" aria-label="Invoice receipt">
         <div className="pos-print-header">
          {props.logoUrl ? <img src={props.logoUrl} alt="Company logo" className="pos-print-logo" /> : null}
          <div className="pos-print-biz-name">{business?.name ?? 'BusinessVault'}</div>
          {business?.address_line1 ? (
            <div className="pos-print-line">{business.address_line1}</div>
          ) : null}
          {business?.city ? (
            <div className="pos-print-line">
              {[business.city, business.state, business.pincode].filter(Boolean).join(' ')}
            </div>
          ) : null}
          {business?.gstin ? (
            <div className="pos-print-line">GSTIN: {business.gstin}</div>
          ) : null}
          {business?.udyamRegistrationNumber ? (
            <div className="pos-print-line">Udyam Registration Number: {business.udyamRegistrationNumber}</div>
          ) : null}
          {business?.phone ? (
            <div className="pos-print-line">Tel: {business.phone}</div>
          ) : null}
        </div>

        <div className="pos-print-sep">--------------------------------</div>

        <div className="pos-print-line">Invoice: {invoice.invoice_number}</div>
        <div className="pos-print-line">Date: {formatPosDateTime(invoice.invoice_date, invoice.created_at)}</div>
        {customer ? (
          <div className="pos-print-line">Customer: {customer.name}</div>
        ) : null}
        {customer?.gstin ? (
          <div className="pos-print-line">GSTIN: {customer.gstin}</div>
        ) : null}

        <div className="pos-print-sep">--------------------------------</div>

        <table className="pos-print-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Item</th>
              <th style={{ textAlign: 'right' }}>Qty</th>
              <th style={{ textAlign: 'right' }}>Rate</th>
              <th style={{ textAlign: 'right' }}>Amt</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const item = itemsById.get(l.item_id);
              const name = item?.name ?? l.description ?? l.item_id;
              return (
                <tr key={l.id}>
                  <td className="pos-print-name" colSpan={4}>
                    {name}
                    {l.hsn ? <span className="pos-print-hsn"> {l.hsn}</span> : null}
                  </td>
                </tr>
              );
            })}
            {lines.map((l) => (
              <tr key={`n-${l.id}`}>
                <td />
                <td style={{ textAlign: 'right' }}>{formatQty(l.qty_micros)}</td>
                <td style={{ textAlign: 'right' }}>
                  {fromMoney(l.unit_price_paise as Money)}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {fromMoney(l.line_total_paise as Money)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="pos-print-sep">--------------------------------</div>

        <TotalRow label="Taxable" value={invoice.taxable_paise} />
        {invoice.discount_paise > 0 ? (
          <TotalRow label="Discount" value={-invoice.discount_paise} />
        ) : null}
        {invoice.cgst_paise > 0 ? (
          <TotalRow label="CGST" value={invoice.cgst_paise} />
        ) : null}
        {invoice.sgst_paise > 0 ? (
          <TotalRow label="SGST" value={invoice.sgst_paise} />
        ) : null}
        {invoice.igst_paise > 0 ? (
          <TotalRow label="IGST" value={invoice.igst_paise} />
        ) : null}
        {invoice.cess_paise > 0 ? (
          <TotalRow label="Cess" value={invoice.cess_paise} />
        ) : null}
        {invoice.round_off_paise !== 0 ? (
          <TotalRow label="Round off" value={invoice.round_off_paise} />
        ) : null}
        <TotalRow label="TOTAL" value={invoice.total_paise} bold />

        <div className="pos-print-sep">--------------------------------</div>

        {payments.map((p, idx) => (
          <TotalRow
            key={`pay-${idx}`}
            label={paymentLabel(p.method)}
            value={p.amount_paise}
          />
        ))}

        <div className="pos-print-sep">--------------------------------</div>

        <div className="pos-print-thanks">Thank you for your business</div>
        <div className="pos-print-line" style={{ textAlign: 'center', fontSize: '9px' }}>
          Powered by BusinessVault
        </div>
      </div>
    </>
  );
}

function TotalRow(props: { label: string; value: number; bold?: boolean }): JSX.Element {
  return (
    <div className={`pos-print-total-row${props.bold ? ' pos-print-bold' : ''}`}>
      <span>{props.label}</span>
      <span>{fromMoney(props.value as Money)}</span>
    </div>
  );
}

function paymentLabel(m: PrintablePayment['method']): string {
  switch (m) {
    case 'cash':
      return 'Cash';
    case 'card':
      return 'Card';
    case 'upi':
      return 'UPI';
    case 'credit':
      return 'Credit';
  }
}

function formatQty(qtyMicros: number): string {
  const n = qtyMicros / 1_000_000;
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

const PRINT_CSS = `
.pos-print-root {
  display: none;
}
@media print {
  @page {
    size: 58mm auto;
    margin: 0;
  }
  body * {
    visibility: hidden;
  }
  .pos-print-root, .pos-print-root * {
    visibility: visible;
  }
  .pos-print-root {
    display: block;
    position: absolute;
    top: 0;
    left: 0;
    width: 58mm;
    padding: 2mm;
    font-family: 'Courier New', ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.25;
    color: #000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .pos-print-header { text-align: center; }
  .pos-print-logo { display: block; max-width: 42mm; max-height: 18mm; margin: 0 auto 1mm; object-fit: contain; }
  .pos-print-biz-name { font-weight: 700; font-size: 13px; }
  .pos-print-line { text-align: left; word-wrap: break-word; }
  .pos-print-header .pos-print-line { text-align: center; }
  .pos-print-sep { text-align: center; letter-spacing: 0; }
  .pos-print-table { width: 100%; border-collapse: collapse; }
  .pos-print-table th { font-weight: 700; padding: 0; font-size: 10px; }
  .pos-print-table td { padding: 0; font-size: 11px; vertical-align: top; }
  .pos-print-name { font-weight: 600; }
  .pos-print-hsn { font-weight: 400; font-size: 9px; margin-left: 4px; }
  .pos-print-total-row {
    display: flex;
    justify-content: space-between;
    padding: 0;
  }
  .pos-print-bold { font-weight: 700; font-size: 12px; }
  .pos-print-thanks { text-align: center; margin-top: 2mm; font-weight: 600; }
}
`;
