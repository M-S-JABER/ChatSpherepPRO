export type TemplateCatalogItem = {
  name: string;
  language?: string;
  description?: string;
  category?: string;
  bodyParams?: number;
  components?: Array<Record<string, any>>;
};
