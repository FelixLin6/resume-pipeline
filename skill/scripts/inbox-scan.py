import imaplib, email, os, re
from email.header import decode_header
pw = None
for line in open(os.path.expanduser('~/zylos/.env')):
    if line.startswith('GMAIL_APP_PASSWORD='):
        pw = line.split('=',1)[1].strip().strip('"').strip("'")
M = imaplib.IMAP4_SSL('imap.gmail.com')
M.login('felixl0808@gmail.com', pw)
M.select('"[Gmail]/All Mail"', readonly=True)
typ, data = M.search(None, '(SINCE "25-Aug-2026")')
ids = data[0].split()
def dh(s):
    out=''
    for part,enc in decode_header(s or ''):
        out += part.decode(enc or 'utf8','replace') if isinstance(part,bytes) else part
    return out
for i in ids:
    typ, md = M.fetch(i, '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])')
    msg = email.message_from_bytes(md[0][1])
    print(f"{dh(msg['Date'])[:31]} | {dh(msg['From'])[:55]} | {dh(msg['Subject'])[:80]}")
M.logout()
