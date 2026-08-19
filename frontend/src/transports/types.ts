export interface PolledNotification {
  id: number;
  status: string;
  created_at: number;
  actor_id: number;
  actor_display_name: string;
  post_id: number | null;
  script_preview: string | null;
}
