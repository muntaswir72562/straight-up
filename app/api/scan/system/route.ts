import { NextResponse } from 'next/server';
import { systemInfo } from '@/lib/server/system';

/** What Scan Book's "Auto" speed means on this PC. */
export async function GET() {
  return NextResponse.json(systemInfo());
}
