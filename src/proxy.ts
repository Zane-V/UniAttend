import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Redirect to lowercase if path contains uppercase letters
  if (path !== path.toLowerCase()) {
    const lowercasePath = path.toLowerCase();
    const url = request.nextUrl.clone();
    url.pathname = lowercasePath;
    return NextResponse.redirect(url, 301);
  }

  return NextResponse.next();
}
