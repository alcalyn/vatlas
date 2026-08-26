/**
 * The samples of the "try it" box and their recorded answers.
 *
 * Samples never call the API: their answers are replayed from here, so they cost nothing and work
 * offline. Other numbers are resolved live through `/v1/demo/lookup/:vatNumber`.
 *
 * The sample chips are also built from this file, so a number and its answer cannot disagree.
 *
 * Every body is a real answer, copied verbatim. To record one again:
 *
 *   curl -s -H "Authorization: Bearer $VATLAS_KEY" $API/v1/lookup/FR08000325175
 *   curl -s -H "Authorization: Bearer $VATLAS_KEY" "$API/v1/lookup/FR08000325175?prefer=proof"
 *   curl -s -H "Authorization: Bearer $VATLAS_KEY" $API/v1/lookup-all/FR08000325175
 *
 * A sample without a `body` for a mode (`XX123456789`) goes to the live API, which answers its own
 * 400.
 */
export const samples = [
  {
    vat: 'FR08000325175',
    /** An imported register: France's SIRENE. */
    single: {
      latency: 38,
      status: 200,
      body: {
        data: {
          vatNumber: 'FR08000325175',
          countryCode: 'FR',
          nationalNumber: '08000325175',
          nationalId: '000325175',
          name: 'THIERRY JANOYER',
          legalForm: 'Personne physique',
          status: 'active',
          address: {
            line1: '51 RUE MARX DORMOY',
            line2: null,
            postalCode: '13004',
            city: 'MARSEILLE',
            country: 'FR',
          },
        },
        meta: {
          source: 'SIRENE',
          sourceDate: '2026-01-05',
          sourceSince: '2026-01-05',
          sourceUpdatedAt: '2025-12-06T09:43:55.000Z',
        },
      },
    },
    // Same number with `?prefer=proof`: answered by VIES, which has no legal form and no national
    // identifier.
    proof: {
      latency: 486,
      status: 200,
      body: {
        data: {
          vatNumber: 'FR08000325175',
          countryCode: 'FR',
          nationalNumber: '08000325175',
          nationalId: null,
          name: 'THIERRY JANOYER',
          legalForm: null,
          status: 'active',
          address: {
            line1: '51 RUE MARX DORMOY',
            line2: null,
            postalCode: '13004',
            city: 'MARSEILLE',
            country: 'FR',
          },
        },
        meta: {
          source: 'VIES',
          sourceDate: '2026-09-04',
          sourceSince: '2026-09-04',
          sourceUpdatedAt: null,
          proof: { type: 'vies_consultation_number', value: 'WAPIAAAAXjR2h1Ky' },
        },
      },
    },
    // Every source. France has no live national register, so SIRENE and VIES answer. SIRENE's history
    // shows a change.
    all: {
      latency: 902,
      status: 200,
      body: {
        data: {
          vatNumber: 'FR08000325175',
          countryCode: 'FR',
          nationalNumber: '08000325175',
          sources: [
            {
              data: {
                vatNumber: 'FR08000325175',
                countryCode: 'FR',
                nationalNumber: '08000325175',
                nationalId: '000325175',
                name: 'THIERRY JANOYER',
                legalForm: 'Personne physique',
                status: 'active',
                address: {
                  line1: '51 RUE MARX DORMOY',
                  line2: null,
                  postalCode: '13004',
                  city: 'MARSEILLE',
                  country: 'FR',
                },
              },
              meta: {
                source: 'SIRENE',
                name: 'SIRENE (INSEE)',
                kind: 'bulk',
                sourceDate: '2026-09-01',
                sourceSince: '2026-01-05',
                sourceUpdatedAt: '2025-12-06T09:43:55.000Z',
              },
              history: [
                {
                  from: '2024-07-02',
                  to: '2025-06-03',
                  status: 'active',
                  nationalId: '000325175',
                  name: 'THIERRY JANOYER',
                  legalForm: 'Personne physique',
                  address: {
                    line1: '14 BOULEVARD DE LA LIBERATION',
                    line2: null,
                    postalCode: '13001',
                    city: 'MARSEILLE',
                    country: 'FR',
                  },
                  sourceUpdatedAt: '2024-07-01T10:00:00.000Z',
                  file: {
                    name: 'StockUniteLegale_utf8.zip',
                    url: 'https://www.data.gouv.fr/fr/datasets/base-sirene-des-entreprises-et-de-leurs-etablissements/',
                  },
                },
                {
                  from: '2026-01-05',
                  to: '2026-09-01',
                  status: 'active',
                  nationalId: '000325175',
                  name: 'THIERRY JANOYER',
                  legalForm: 'Personne physique',
                  address: {
                    line1: '51 RUE MARX DORMOY',
                    line2: null,
                    postalCode: '13004',
                    city: 'MARSEILLE',
                    country: 'FR',
                  },
                  sourceUpdatedAt: '2025-12-06T09:43:55.000Z',
                  file: {
                    name: 'StockUniteLegale_utf8.zip',
                    url: 'https://www.data.gouv.fr/fr/datasets/base-sirene-des-entreprises-et-de-leurs-etablissements/',
                  },
                },
              ],
            },
            {
              data: {
                vatNumber: 'FR08000325175',
                countryCode: 'FR',
                nationalNumber: '08000325175',
                nationalId: null,
                name: 'THIERRY JANOYER',
                legalForm: null,
                status: 'active',
                address: {
                  line1: '51 RUE MARX DORMOY',
                  line2: null,
                  postalCode: '13004',
                  city: 'MARSEILLE',
                  country: 'FR',
                },
              },
              meta: {
                source: 'VIES',
                name: 'VIES (European Commission)',
                kind: 'live',
                sourceDate: '2026-09-04',
                sourceSince: '2026-09-04',
                sourceUpdatedAt: null,
                proof: {
                  type: 'vies_consultation_number',
                  value: 'WAPIAAAAXjR2h1Ky',
                },
                call: {
                  status: 'found',
                  checkedAt: '2026-09-04T22:01:59.219Z',
                  proof: {
                    type: 'vies_consultation_number',
                    value: 'WAPIAAAAXjR2h1Ky',
                  },
                },
              },
              history: [
                {
                  from: '2026-09-04',
                  to: '2026-09-04',
                  status: 'active',
                  nationalId: null,
                  name: 'THIERRY JANOYER',
                  legalForm: null,
                  address: {
                    line1: '51 RUE MARX DORMOY',
                    line2: null,
                    postalCode: '13004',
                    city: 'MARSEILLE',
                    country: 'FR',
                  },
                  sourceUpdatedAt: null,
                  proof: {
                    type: 'vies_consultation_number',
                    value: 'WAPIAAAAXjR2h1Ky',
                  },
                },
              ],
            },
          ],
        },
      },
    },
  },
  {
    vat: 'PL7342867148',
    /** A live register: Poland's White List. */
    single: {
      latency: 412,
      status: 200,
      body: {
        data: {
          vatNumber: 'PL7342867148',
          countryCode: 'PL',
          nationalNumber: '7342867148',
          nationalId: '7342867148',
          name: 'COMARCH SPÓŁKA AKCYJNA',
          legalForm: null,
          status: 'active',
          address: {
            line1: 'AL. JANA PAWŁA II 39A, 31-864 KRAKÓW',
            line2: null,
            postalCode: null,
            city: null,
            country: 'PL',
          },
        },
        meta: {
          source: 'MF_WL',
          sourceDate: '2026-08-28',
          sourceSince: '2026-08-28',
          sourceUpdatedAt: '2026-08-26T09:12:44.118Z',
        },
      },
    },
    proof: {
      latency: 331,
      status: 200,
      body: {
        data: {
          vatNumber: 'PL7342867148',
          countryCode: 'PL',
          nationalNumber: '7342867148',
          nationalId: null,
          name: 'COMARCH SPÓŁKA AKCYJNA',
          legalForm: null,
          status: 'active',
          address: {
            line1: 'AL. JANA PAWŁA II 39A',
            line2: null,
            postalCode: '31-864',
            city: 'KRAKÓW',
            country: 'PL',
          },
        },
        meta: {
          source: 'VIES',
          sourceDate: '2026-09-04',
          sourceSince: '2026-09-04',
          sourceUpdatedAt: null,
          proof: { type: 'vies_consultation_number', value: 'WAPIAAAAXjNqB7dR' },
        },
      },
    },
    // Poland has no bulk file, so both sources are live and each has a `call`.
    all: {
      latency: 1140,
      status: 200,
      body: {
        data: {
          vatNumber: 'PL7342867148',
          countryCode: 'PL',
          nationalNumber: '7342867148',
          sources: [
            {
              data: {
                vatNumber: 'PL7342867148',
                countryCode: 'PL',
                nationalNumber: '7342867148',
                nationalId: '7342867148',
                name: 'COMARCH SPÓŁKA AKCYJNA',
                legalForm: null,
                status: 'active',
                address: {
                  line1: 'AL. JANA PAWŁA II 39A, 31-864 KRAKÓW',
                  line2: null,
                  postalCode: null,
                  city: null,
                  country: 'PL',
                },
              },
              meta: {
                source: 'MF_WL',
                name: 'Wykaz podatników VAT (Ministerstwo Finansów)',
                kind: 'live',
                sourceDate: '2026-09-04',
                sourceSince: '2026-08-28',
                sourceUpdatedAt: '2026-08-26T09:12:44.118Z',
                call: {
                  status: 'found',
                  checkedAt: '2026-09-04T22:02:01.004Z',
                },
              },
              history: [
                {
                  from: '2026-08-28',
                  to: '2026-09-04',
                  status: 'active',
                  nationalId: '7342867148',
                  name: 'COMARCH SPÓŁKA AKCYJNA',
                  legalForm: null,
                  address: {
                    line1: 'AL. JANA PAWŁA II 39A, 31-864 KRAKÓW',
                    line2: null,
                    postalCode: null,
                    city: null,
                    country: 'PL',
                  },
                  sourceUpdatedAt: '2026-08-26T09:12:44.118Z',
                },
              ],
            },
            {
              data: {
                vatNumber: 'PL7342867148',
                countryCode: 'PL',
                nationalNumber: '7342867148',
                nationalId: null,
                name: 'COMARCH SPÓŁKA AKCYJNA',
                legalForm: null,
                status: 'active',
                address: {
                  line1: 'AL. JANA PAWŁA II 39A',
                  line2: null,
                  postalCode: '31-864',
                  city: 'KRAKÓW',
                  country: 'PL',
                },
              },
              meta: {
                source: 'VIES',
                name: 'VIES (European Commission)',
                kind: 'live',
                sourceDate: '2026-09-04',
                sourceSince: '2026-09-04',
                sourceUpdatedAt: null,
                proof: {
                  type: 'vies_consultation_number',
                  value: 'WAPIAAAAXjNqB7dR',
                },
                call: {
                  status: 'found',
                  checkedAt: '2026-09-04T22:02:01.318Z',
                  proof: {
                    type: 'vies_consultation_number',
                    value: 'WAPIAAAAXjNqB7dR',
                  },
                },
              },
              history: [
                {
                  from: '2026-09-04',
                  to: '2026-09-04',
                  status: 'active',
                  nationalId: null,
                  name: 'COMARCH SPÓŁKA AKCYJNA',
                  legalForm: null,
                  address: {
                    line1: 'AL. JANA PAWŁA II 39A',
                    line2: null,
                    postalCode: '31-864',
                    city: 'KRAKÓW',
                    country: 'PL',
                  },
                  sourceUpdatedAt: null,
                  proof: {
                    type: 'vies_consultation_number',
                    value: 'WAPIAAAAXjNqB7dR',
                  },
                },
              ],
            },
          ],
        },
      },
    },
  },
  {
    vat: 'EE101335276',
    /** Estonia's business register, imported. */
    single: {
      latency: 31,
      status: 200,
      body: {
        data: {
          vatNumber: 'EE101335276',
          countryCode: 'EE',
          nationalNumber: '101335276',
          nationalId: '10165950',
          name: 'AS Eesti Meedia',
          legalForm: 'Aktsiaselts',
          status: 'active',
          address: {
            line1: 'Maakri tn 23a',
            line2: null,
            postalCode: '10145',
            city: 'Tallinn',
            country: 'EE',
          },
        },
        meta: {
          source: 'RIK',
          sourceDate: '2026-08-25',
          sourceSince: '2026-08-25',
          sourceUpdatedAt: '2026-08-25T02:31:07.000Z',
        },
      },
    },
    proof: {
      latency: 402,
      status: 200,
      body: {
        data: {
          vatNumber: 'EE101335276',
          countryCode: 'EE',
          nationalNumber: '101335276',
          nationalId: null,
          name: 'Aktsiaselts Eesti Meedia',
          legalForm: null,
          status: 'active',
          address: {
            line1: 'Maakri tn 23a',
            line2: null,
            postalCode: '10145',
            city: 'Tallinn',
            country: 'EE',
          },
        },
        meta: {
          source: 'VIES',
          sourceDate: '2026-09-04',
          sourceSince: '2026-09-04',
          sourceUpdatedAt: null,
          proof: { type: 'vies_consultation_number', value: 'WAPIAAAAXjQ8mT1w' },
        },
      },
    },
    // One imported register and one live call, disagreeing on the name (RIK abbreviates it).
    all: {
      latency: 838,
      status: 200,
      body: {
        data: {
          vatNumber: 'EE101335276',
          countryCode: 'EE',
          nationalNumber: '101335276',
          sources: [
            {
              data: {
                vatNumber: 'EE101335276',
                countryCode: 'EE',
                nationalNumber: '101335276',
                nationalId: '10165950',
                name: 'AS Eesti Meedia',
                legalForm: 'Aktsiaselts',
                status: 'active',
                address: {
                  line1: 'Maakri tn 23a',
                  line2: null,
                  postalCode: '10145',
                  city: 'Tallinn',
                  country: 'EE',
                },
              },
              meta: {
                source: 'RIK',
                name: 'e-Business Register open data (RIK)',
                kind: 'bulk',
                sourceDate: '2026-08-25',
                sourceSince: '2026-02-24',
                sourceUpdatedAt: '2026-08-25T02:31:07.000Z',
              },
              history: [
                {
                  from: '2026-02-24',
                  to: '2026-08-25',
                  status: 'active',
                  nationalId: '10165950',
                  name: 'AS Eesti Meedia',
                  legalForm: 'Aktsiaselts',
                  address: {
                    line1: 'Maakri tn 23a',
                    line2: null,
                    postalCode: '10145',
                    city: 'Tallinn',
                    country: 'EE',
                  },
                  sourceUpdatedAt: '2026-08-25T02:31:07.000Z',
                  file: {
                    name: 'ettevotja_rekvisiidid__yldandmed.csv.zip',
                    url: 'https://avaandmed.ariregister.rik.ee/et/avaandmete-allalaadimine',
                  },
                },
              ],
            },
            {
              data: {
                vatNumber: 'EE101335276',
                countryCode: 'EE',
                nationalNumber: '101335276',
                nationalId: null,
                name: 'Aktsiaselts Eesti Meedia',
                legalForm: null,
                status: 'active',
                address: {
                  line1: 'Maakri tn 23a',
                  line2: null,
                  postalCode: '10145',
                  city: 'Tallinn',
                  country: 'EE',
                },
              },
              meta: {
                source: 'VIES',
                name: 'VIES (European Commission)',
                kind: 'live',
                sourceDate: '2026-09-04',
                sourceSince: '2026-09-04',
                sourceUpdatedAt: null,
                proof: {
                  type: 'vies_consultation_number',
                  value: 'WAPIAAAAXjQ8mT1w',
                },
                call: {
                  status: 'found',
                  checkedAt: '2026-09-04T22:02:03.771Z',
                  proof: {
                    type: 'vies_consultation_number',
                    value: 'WAPIAAAAXjQ8mT1w',
                  },
                },
              },
              history: [
                {
                  from: '2026-09-04',
                  to: '2026-09-04',
                  status: 'active',
                  nationalId: null,
                  name: 'Aktsiaselts Eesti Meedia',
                  legalForm: null,
                  address: {
                    line1: 'Maakri tn 23a',
                    line2: null,
                    postalCode: '10145',
                    city: 'Tallinn',
                    country: 'EE',
                  },
                  sourceUpdatedAt: null,
                  proof: {
                    type: 'vies_consultation_number',
                    value: 'WAPIAAAAXjQ8mT1w',
                  },
                },
              ],
            },
          ],
        },
      },
    },
  },
  {
    // No recorded body: this sample goes to the API to show its real 400 answer, which costs nothing.
    vat: 'XX123456789',
  },
]

/** The recorded answer for one sample and mode, or undefined. */
export function recorded(vat, mode) {
  const sample = samples.find((entry) => entry.vat === vat)
  return sample ? sample[mode] : undefined
}
