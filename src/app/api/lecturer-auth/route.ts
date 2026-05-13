import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

const LECTURER_PASSWORD_HASH = process.env.LECTURER_PASSWORD_HASH || '';

function verifyPassword(password: string, hash: string): boolean {
  if (!hash) return false;
  const expectedHash = crypto.createHash('sha256').update(password).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(hash, 'hex'));
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { password } = body;

    if (!LECTURER_PASSWORD_HASH) {
      return NextResponse.json({ error: 'Server configuration error.' }, { status: 500 });
    }

    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: 'Password required.' }, { status: 400 });
    }

    if (!verifyPassword(password.trim().toUpperCase(), LECTURER_PASSWORD_HASH)) {
      return NextResponse.json({ error: 'Invalid password.' }, { status: 401 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Authentication failed.' }, { status: 500 });
  }
}