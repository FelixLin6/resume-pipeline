#!/usr/bin/env python3
"""swelist-fetch — Stage 1 step 1: pull the newest SWElist daily email over IMAP
and parse its posting rows into JSON (email order preserved).

  swelist-fetch.py [--date YYYY-MM-DD | --imap-id N] [--out FILE] [--list]

Output: {"email": {"imap_id", "subject", "date", "from", "row_count"},
         "rows": [{"idx", "company", "title", "link"}, ...]}
  --list  prints the recent SWElist emails (id | date | subject) and exits.
Credentials: GMAIL_APP_PASSWORD in ~/zylos/.env (never printed). Read-only IMAP.
"""
import argparse, email, html, imaplib, json, os, re, sys
from email.header import decode_header
from email.utils import parsedate_to_datetime

ACCOUNT = 'felixl0808@gmail.com'
ROW_RE = re.compile(r'<p class="internship">\s*<strong>(.*?):?\s*</strong>\s*<a href="([^"]+)"[^>]*>(.*?)</a>', re.S)


def env_password():
    for line in open(os.path.expanduser('~/zylos/.env')):
        if line.startswith('GMAIL_APP_PASSWORD='):
            return line.split('=', 1)[1].strip().strip('"').strip("'")
    sys.exit('GMAIL_APP_PASSWORD not found in ~/zylos/.env')


def dh(s):
    out = ''
    for part, enc in decode_header(s or ''):
        out += part.decode(enc or 'utf8', 'replace') if isinstance(part, bytes) else part
    return out


def clean(s):
    return html.unescape(re.sub(r'<[^>]+>', '', s)).replace('\xa0', ' ').strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', help='pick the SWElist email sent on this date (YYYY-MM-DD, sender TZ = UTC)')
    ap.add_argument('--imap-id', type=int, help='pick this exact IMAP id')
    ap.add_argument('--out', help='write JSON here instead of stdout')
    ap.add_argument('--list', action='store_true', help='list recent SWElist emails and exit')
    ap.add_argument('--since-days', type=int, default=14)
    a = ap.parse_args()

    M = imaplib.IMAP4_SSL('imap.gmail.com')
    M.login(ACCOUNT, env_password())
    M.select('"[Gmail]/All Mail"', readonly=True)
    import datetime as dt
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.since_days)).strftime('%d-%b-%Y')
    typ, data = M.search(None, f'(FROM "swelist.com" SINCE "{since}")')
    ids = [int(i) for i in data[0].split()]
    if not ids:
        sys.exit(f'no SWElist email since {since}')

    heads = []
    for i in ids:
        typ, md = M.fetch(str(i), '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])')
        msg = email.message_from_bytes(md[0][1])
        subj = dh(msg['Subject'])
        if 'internship' not in subj.lower():
            continue
        heads.append((i, dh(msg['Date']), subj, dh(msg['From'])))

    if a.list:
        for i, d, s, f in heads:
            print(f'{i} | {d} | {s}')
        M.logout(); return

    pick = None
    if a.imap_id:
        pick = next((h for h in heads if h[0] == a.imap_id), None)
    elif a.date:
        for h in heads:
            try:
                if parsedate_to_datetime(h[1]).strftime('%Y-%m-%d') == a.date:
                    pick = h
            except Exception:
                pass
    else:
        pick = heads[-1] if heads else None
    if not pick:
        sys.exit('no matching SWElist daily email (use --list)')

    i, date, subj, frm = pick
    typ, md = M.fetch(str(i), '(BODY.PEEK[])')
    msg = email.message_from_bytes(md[0][1])
    body = None
    for part in msg.walk():
        if part.get_content_type() == 'text/html':
            body = part.get_payload(decode=True).decode(part.get_content_charset() or 'utf8', 'replace')
    M.logout()
    if not body:
        sys.exit('email has no HTML part')

    rows = []
    for n, (co, link, title) in enumerate(ROW_RE.findall(body), 1):
        rows.append({'idx': n, 'company': clean(co), 'title': clean(title), 'link': html.unescape(link.strip())})
    out = {'email': {'imap_id': i, 'subject': subj, 'date': date, 'from': frm, 'row_count': len(rows)}, 'rows': rows}
    txt = json.dumps(out, indent=1, ensure_ascii=False)
    if a.out:
        open(a.out, 'w').write(txt)
        print(f'{len(rows)} rows from IMAP id {i} ({subj}) -> {a.out}', file=sys.stderr)
    else:
        print(txt)


if __name__ == '__main__':
    main()
