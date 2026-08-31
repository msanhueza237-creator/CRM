export type ContentChannelCode = "instagram" | "facebook";
export type ContentOperationMode = "manual" | "approval" | "autopilot";
export type ContentVisualStyle = "original" | "editorial" | "technical" | "promotion";

export interface ContentCreativeLayout {
  style: ContentVisualStyle;
  headline: string;
  supporting_text: string;
  badge: string;
  website: string;
}
export type ContentPublicationStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "partial"
  | "paused"
  | "cancelled";

export interface ContentChannel {
  id: string;
  code: ContentChannelCode;
  name: string;
  enabled: boolean;
  operation_mode: ContentOperationMode;
  external_account_id: string | null;
  external_account_name: string | null;
  last_checked_at: string | null;
  last_error: string | null;
}

export interface ContentProduct {
  id: string;
  external_id: string;
  sku: string | null;
  name: string;
  description_text: string | null;
  category: string | null;
  categories: unknown[];
  variants: unknown[];
  price: number | null;
  promotional_price: number | null;
  stock: number | null;
  has_stock: boolean | null;
  brand: string | null;
  images: Array<{ src?: string; alt?: Record<string, string> }>;
  primary_image_url: string | null;
  product_url: string | null;
  source_status: "active" | "unpublished" | "deleted" | "invalid";
  sync_status: "synced" | "incomplete" | "error";
  missing_fields: string[];
  paused: boolean;
  pause_reason: string | null;
  source_updated_at: string | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface ContentTemplate {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  channels: ContentChannelCode[];
  instruction: string;
  structure: Record<string, unknown>;
  active: boolean;
  system_template: boolean;
  created_at: string;
  updated_at: string;
}

export interface BrandProfile {
  id: string;
  name: string;
  brand_name: string;
  description: string;
  tone: string;
  formality: number;
  emoji_policy: "none" | "low" | "moderate" | "expressive";
  commercial_style: string;
  technical_style: string;
  recommended_words: string[];
  forbidden_words: string[];
  cta_style: string;
  hashtag_rules: string;
  key_messages: string[];
  differentiators: string[];
  additional_instructions: string;
  active: boolean;
  is_default: boolean;
  configured: boolean;
  created_at: string;
  updated_at: string;
}

export interface ContentPublication {
  id: string;
  generation_group_id: string;
  product_id: string | null;
  channel_id: string;
  template_id: string | null;
  brand_profile_id: string | null;
  publication_type: string;
  objective: string;
  cta: string;
  body: string;
  hashtags: string[];
  image_url: string | null;
  source_facts: Record<string, unknown>;
  missing_facts: string[];
  model_name: string | null;
  operation_mode: ContentOperationMode;
  status: ContentPublicationStatus;
  scheduled_at: string | null;
  published_at: string | null;
  external_id: string | null;
  external_url: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  correlation_id: string;
  created_at: string;
  updated_at: string;
}

export interface ContentSchedule {
  id: string;
  name: string;
  channel_ids: string[];
  recurrence_type: "once" | "daily" | "interval_days" | "weekdays";
  recurrence_rule: Record<string, unknown>;
  product_filter: Record<string, unknown>;
  operation_mode: ContentOperationMode;
  timezone: string;
  starts_at: string;
  ends_at: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  active: boolean;
  paused_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContentAutomationRule {
  id: string;
  name: string;
  channel_id: string | null;
  enabled: boolean;
  operation_mode: "approval" | "autopilot";
  min_product_gap_days: number;
  min_text_similarity_gap_days: number;
  category_rotation: boolean;
  require_stock: boolean;
  require_image: boolean;
  max_retries: number;
  settings: Record<string, unknown>;
}

export interface ContentHistoryEvent {
  id: string;
  publication_id: string | null;
  product_id: string | null;
  job_id: string | null;
  event_type: string;
  level: "debug" | "info" | "warning" | "error";
  message: string;
  metadata: Record<string, unknown>;
  correlation_id: string | null;
  actor_type: "user" | "agent" | "worker" | "system";
  actor_id: string | null;
  created_at: string;
}

export interface ContentBootstrap {
  profile: { role: string; permissions: string[] };
  connections: Array<{
    provider: string;
    enabled: boolean;
    status: string;
    message: string;
    last_success_at: string | null;
  }>;
  channels: ContentChannel[];
  templates: ContentTemplate[];
  brands: BrandProfile[];
  schedules: ContentSchedule[];
  automationRules: ContentAutomationRule[];
  firstSync: Record<string, unknown> | null;
  summary: {
    products: number;
    productsIncomplete: number;
    productsPaused: number;
    publications: number;
    publishedThisWeek: number;
    scheduledThisWeek: number;
    pendingApproval: number;
    failed: number;
    nextPublication: Partial<ContentPublication> | null;
  };
}

export interface ContentConnectionCheck {
  tiendanube: ContentBootstrap["connections"][number] | null;
  instagram: { connected: boolean; status: string; message: string; accountId?: string; accountName?: string };
  facebook: { connected: boolean; status: string; message: string; accountId?: string; accountName?: string };
}
