// Mock endpoint for the InputSelect remote-mode demo. Same contract as
// SAAS_BOILER's /api/design-system/cities: ?q=&page=&limit= -> PaginatedResponse.
import { NextResponse, type NextRequest } from 'next/server'
import type { PaginatedResponse } from '@aspiralabs/ui'

type City = { id: string; name: string; country: string }

const NAMES: Array<[string, string]> = [
  ['Amsterdam', 'Netherlands'], ['Athens', 'Greece'], ['Auckland', 'New Zealand'], ['Austin', 'USA'], ['Bangkok', 'Thailand'],
  ['Barcelona', 'Spain'], ['Berlin', 'Germany'], ['Boston', 'USA'], ['Buenos Aires', 'Argentina'], ['Cairo', 'Egypt'],
  ['Cape Town', 'South Africa'], ['Chicago', 'USA'], ['Copenhagen', 'Denmark'], ['Denver', 'USA'], ['Dubai', 'UAE'],
  ['Dublin', 'Ireland'], ['Edinburgh', 'Scotland'], ['Helsinki', 'Finland'], ['Hong Kong', 'China'], ['Istanbul', 'Turkey'],
  ['Jakarta', 'Indonesia'], ['Johannesburg', 'South Africa'], ['Lagos', 'Nigeria'], ['Lima', 'Peru'], ['Lisbon', 'Portugal'],
  ['London', 'United Kingdom'], ['Los Angeles', 'USA'], ['Madrid', 'Spain'], ['Manila', 'Philippines'], ['Melbourne', 'Australia'],
  ['Mexico City', 'Mexico'], ['Miami', 'USA'], ['Montreal', 'Canada'], ['Moscow', 'Russia'], ['Mumbai', 'India'],
  ['Nairobi', 'Kenya'], ['New York', 'USA'], ['Oslo', 'Norway'], ['Paris', 'France'], ['Prague', 'Czech Republic'],
  ['Reykjavik', 'Iceland'], ['Rio de Janeiro', 'Brazil'], ['Rome', 'Italy'], ['San Francisco', 'USA'], ['Santiago', 'Chile'],
  ['São Paulo', 'Brazil'], ['Seattle', 'USA'], ['Seoul', 'South Korea'], ['Shanghai', 'China'], ['Singapore', 'Singapore'],
  ['Stockholm', 'Sweden'], ['Sydney', 'Australia'], ['Taipei', 'Taiwan'], ['Tel Aviv', 'Israel'], ['Tokyo', 'Japan'],
  ['Toronto', 'Canada'], ['Vancouver', 'Canada'], ['Vienna', 'Austria'], ['Warsaw', 'Poland'], ['Washington', 'USA'], ['Zurich', 'Switzerland'],
]
const CITIES: City[] = NAMES.map(([name, country]) => ({ id: name.toLowerCase().replace(/[^a-z]+/g, '-'), name, country }))

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim().toLowerCase()
  const limit = Math.min(Math.max(parseInt(sp.get('limit') ?? '20', 10) || 20, 1), 100)
  const page = Math.max(parseInt(sp.get('page') ?? '1', 10) || 1, 1)
  const filtered = CITIES.filter((c) => !q || c.name.toLowerCase().includes(q) || c.country.toLowerCase().includes(q))
  const totalCount = filtered.length
  const totalPages = Math.max(Math.ceil(totalCount / limit), 1)
  const skip = (page - 1) * limit
  await new Promise((r) => setTimeout(r, 250))
  const body: PaginatedResponse<City> = {
    data: filtered.slice(skip, skip + limit),
    pagination: { page, limit, totalCount, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1 },
  }
  return NextResponse.json(body)
}
