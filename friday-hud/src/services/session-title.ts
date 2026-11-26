// Session titles come from the first message; strip transport noise like "[message_id: run_…]".
export function cleanSessionTitle(title: string | undefined): string {
  return (title ?? '').replace(/\s*\[message_id:[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
}
