export interface User {
  id: number;
  mobile: string;
  owner_name: string;
  farm_name: string;
  avatar_url: string | null;
  address: string | null;
  low_stock_threshold: number;
  kg_per_bag: number;
  default_tax_percent: number;
  eggs_per_tray: number;
}

export type InvoiceType = 'egg_sale' | 'spent_hen_sale' | 'feed_trade';

export const INVOICE_TYPE_LABEL: Record<InvoiceType, string> = {
  egg_sale: 'Egg Sale',
  spent_hen_sale: 'Spent Hen Sale',
  feed_trade: 'Feed Trade',
};
