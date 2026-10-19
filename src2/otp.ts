/** Extract OTPs and verification links from email text - feeds the sign-up engine. */

export function extractOtp(text: string): string | null {
  const t = text.replace(/\s+/g, " ");
  // Prefer numbers explicitly near otp/code/verification words
  const near = t.match(/(?:otp|one[- ]time|verification code|security code|confirm(?:ation)? code|code is|pin)[^0-9]{0,25}(\d{4,8})\b/i);
  if (near) return near[1];
  // Fallback: a standalone 6-digit number
  const solo = t.match(/\b(\d{6})\b/);
  return solo ? solo[1] : null;
}

export function extractVerificationLink(text: string): string | null {
  const links = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
  const scored = links
    .filter((u) => !/unsubscribe|privacy|terms|logo|twitter|facebook/i.test(u))
    .map((u) => {
      let s = 0;
      if (/verif|confirm|activate|token|signup|sign-up|auth|magic/i.test(u)) s += 10;
      if (/click|here/i.test(u)) s += 1;
      return { u, s };
    })
    .sort((a, b) => b.s - a.s);
  return scored.length && scored[0].s > 0 ? scored[0].u : null;
}
