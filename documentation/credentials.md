# Credentials

Some registers are free but need an account. All of them are optional: without credentials the
source is skipped and the lookup falls back to VIES. New Zealand is the exception: there is no VIES
outside the EU, so without `NZBN_API_KEY` New Zealand numbers answer `unavailable`.

| Country     | Variables                                   | Who can get one                      |
| ----------- | ------------------------------------------- | ------------------------------------ |
| Belgium     | `KBO_USER` / `KBO_PASSWORD`                 | anyone, self-service                 |
| Denmark     | `CVR_USER` / `CVR_PASSWORD`                 | anyone, on request                   |
| Croatia     | `SUDREG_CLIENT_ID` / `SUDREG_CLIENT_SECRET` | anyone, self-service                 |
| Greece      | `GEMI_API_KEY`                              | anyone, by email in 1-3 working days |
| Greece      | `AADE_USER` / `AADE_PASSWORD`               | Greek taxpayers only (TAXISnet)      |
| New Zealand | `NZBN_API_KEY`                              | anyone, self-service                 |

## Belgium: KBO / BCE open data

1. Sign up at <https://kbopub.economie.fgov.be/kbo-open-data/login?lang=en>, confirm your email
   and accept the terms. The data may not be used for direct marketing.
2. Set `KBO_USER` and `KBO_PASSWORD`.

The full extract is published daily and kept 31 days. Its name contains a sequence number, so the
importer reads the listing at `/kbo-open-data/affiliation/xml/?files` and takes the newest `Full`
file. SFTP access is available on request to <kbo-bce-webservice@economie.fgov.be>.

## Denmark: CVR system-to-system access

Free, but credentials are issued by hand.

1. Go to <https://datacvr.virk.dk/artikel/system-til-system-adgang-til-cvr-data>.
2. Apply with the form behind "Anmod om adgang til system-til-systemløsningen". Emailing
   <cvrselvbetjening@erst.dk> first only gets you a link back to this form.
3. Sign the declaration about advertisement-protected companies (_reklamebeskyttelse_).
4. Set `CVR_USER` and `CVR_PASSWORD`.

Access is HTTP Basic auth on an Elasticsearch endpoint
(`distribution.virk.dk/cvr-permanent/virksomhed/_search`), updated close to real time.

## Croatia: Sudski registar

Free and self-service, about five minutes.

1. Register at <https://sudreg-data.gov.hr> (a separate sandbox exists at
   <https://sudreg-data-test.gov.hr>). Pick the user type `javni` (public).
2. Verify your email. The verification page shows the **Client ID** and **Client Secret**. Keep
   that URL: it is the way back to the credentials.
3. The values end with two dots (`..`) that are part of the secret. Quote them in `.env`:

   ```
   SUDREG_CLIENT_ID="xxxxxxxx.."
   SUDREG_CLIENT_SECRET="yyyyyyyy.."
   ```

4. Check them:

   ```bash
   curl -su "$SUDREG_CLIENT_ID:$SUDREG_CLIENT_SECRET" \
     -d grant_type=client_credentials \
     https://sudreg-data.gov.hr/api/oauth/token
   ```

To get back into the account later: open
<https://sudreg-data.gov.hr/ords/srn_rep/r/vanjski-srn-rep/home>, open the side menu, click
"Oporavak računa" and enter your email.

The register is refreshed once per working day, overnight. Support:
<sudski.registar@pravosudje.hr> (quote the `X-Log-Id` response header).

## Greece: GEMI open data

No Greek account needed, and searchable by AFM (the Greek VAT number).

1. Register at <https://opendata.businessportal.gr/register/>. Approval takes 1-3 working days.
2. Set `GEMI_API_KEY`.
3. Check it:

   ```bash
   curl -H "api_key: $GEMI_API_KEY" \
     'https://opendata-api.businessportal.gr/api/opendata/v1/companies?afm=093371507&resultsSize=1'
   ```

Limits, all handled by the adapter:

- 8 requests per minute. A 429 is treated as a miss. A higher limit can be requested from
  <support@uhc.gr>.
- An unknown AFM answers 404 with an empty body.
- Coverage is incomplete, so AADE and VIES stay in the chain.
- Search by AFM takes about 2.3 s (VIES takes 0.3 s), which is why GEMI is asked after VIES.

The data is published under ODC-BY-1.0 and must be credited. Docs:
<https://opendata.businessportal.gr/techdocs/>.

## Greece: AADE RgWsPublic2

Asked before VIES for `EL` numbers. Requires a Greek TAXISnet account (a Greek taxpayer or the
representative of a Greek company).

1. Log in to <https://www1.aade.gr/sgsisapps/tokenservices/protected/displayConsole.htm> with your
   TAXISnet credentials. For a company, only its registered representative can do this.
2. Under "Διαθέσιμες Υπηρεσίες", pick "Αναζήτηση Βασικών Στοιχείων Μητρώου Επιχειρήσεων".
3. Create a special code pair ("Δημιουργία Ειδικού Κωδικού"): a username of at least 10 uppercase
   letters and digits, and a password. This is not your TAXISnet login.
4. Activate the service and accept its terms.
5. Set `AADE_USER` and `AADE_PASSWORD`.

Business errors come back as HTTP 200 with an `errorCode` in the body. There is no bulk file.

## New Zealand: NZBN API

1. Register at <https://portal.api.business.govt.nz/>.
2. Subscribe to the NZBN API. You get a primary and a secondary key, both equivalent.
3. Set `NZBN_API_KEY` to the primary key. It is sent as `Ocp-Apim-Subscription-Key`.

Notes:

- The gateway has no 404. An unallocated NZBN answers 400 with `Could not find NZBN Number`, which
  the adapter reads as `not-found`.
- The NZBN is not the tax number (the IRD number is not public), but it is the identifier used on
  invoices.
- The bulk extract needs a separate application, so New Zealand is resolved on demand.
