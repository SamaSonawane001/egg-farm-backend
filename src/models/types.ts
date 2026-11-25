export interface User {
  id: string;
  farm_id: string;
  mobile: string;
  owner_name: string;
  farm_name: string;
  avatar_url: string | null;
  signature_url: string | null;
  payment_qr_url: string | null;
  address: string | null;
  low_stock_threshold: number;
  kg_per_bag: number;
  default_tax_percent: number;
  eggs_per_tray: number;
  is_primary: boolean;
  shared_inventory_enabled: boolean;
}

export type InvoiceType =
  | 'egg_sale'
  | 'spent_hen_sale'
  | 'poultry_manure_sale'
  | 'feed_trade';

export const INVOICE_TYPE_LABEL: Record<InvoiceType, string> = {
  egg_sale: 'Egg Sale',
  spent_hen_sale: 'Spent Hen Sale',
  poultry_manure_sale: 'Poultry Manure Sale',
  feed_trade: 'Feed Trade',
};

export type InvoiceSaleUnit = 'bag' | 'tractor_trolley' | 'ton';

export const INVOICE_SALE_UNIT_LABEL: Record<InvoiceSaleUnit, string> = {
  bag: 'bag',
  tractor_trolley: 'trolley',
  ton: 'ton',
};
