import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowsUpDownIcon,
  BuildingOffice2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  Cog6ToothIcon,
  HomeIcon,
  MicrophoneIcon,
  PencilSquareIcon,
  TruckIcon,
} from '@heroicons/react/24/outline'
import { importLibrary, setOptions } from '@googlemaps/js-api-loader'

type RouteSummary = {
  loadedDistanceKm: number
  deadheadDistanceKm: number
  driveTimeMinutes: number
  loadedCost: number
  deadheadCost: number
  minimumChargeAdjustment: number
  subtotal: number
  gst: number
  total: number
}

type QuoteRecord = {
  quoteNumber: string
  customer: string
  customerPhone: string
  customerEmail: string
  pickup: string
  dropoff: string
  loadDescription: string
  trailerType: string
  loadWeightLbs: string
  loadedKm: number
  deadheadKm: number
  driveTime: string
  loadedCost: number
  deadheadCost: number
  minimumChargeAdjustment: number
  subtotal: number
  gst: number
  total: number
  notes?: string
  createdAt: string
}

type CustomerRecord = {
  name: string
  phone: string
  email: string
  notes: string
}

type Settings = {
  loadedRate: number
  deadheadRate: number
  gstRate: number
  minimumCharge: number
  yardAddress: string
  companyName: string
  companyPhone: string
  companyEmail: string
  companyGstNumber: string
  deadheadFuelEconomy: number
  loadedFuelEconomy: number
  dieselPrice: number
}

type SpeechRecognitionEventLike = { results: ArrayLike<ArrayLike<{ transcript: string }>> }
type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onstart: (() => void) | null
  start: () => void
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike
type GoogleAutocompleteSuggestion = {
  placePrediction?: { text?: { text?: string } }
}
type GooglePlacesLibrary = {
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions: (request: { input: string; includedRegionCodes?: string[]; sessionToken?: object | null }) => Promise<{ suggestions: GoogleAutocompleteSuggestion[] }>
  }
  AutocompleteSessionToken: new () => object
}
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void> }

declare global {
  interface Window {
    webkitSpeechRecognition?: SpeechRecognitionConstructor
    SpeechRecognition?: SpeechRecognitionConstructor
  }
}

const STORAGE_KEYS = {
  settings: 'fwf-hauling-settings',
  quotes: 'fwf-hauling-quotes',
  recentPickup: 'fwf-hauling-recent-pickup',
  recentDropoff: 'fwf-hauling-recent-dropoff',
  customers: 'fwf-hauling-customers',
}

const DEFAULT_SETTINGS: Settings = {
  loadedRate: 2.5,
  deadheadRate: 0.8,
  gstRate: 0.05,
  minimumCharge: 250,
  yardAddress: '50142 Mun 40E Ste. Genevieve, MB R5J 0A5',
  companyName: 'FWF Hauling Companion',
  companyPhone: '(204) 555-0101',
  companyEmail: 'dispatch@fwfhauling.ca',
  companyGstNumber: 'GST-12345',
  deadheadFuelEconomy: 14,
  loadedFuelEconomy: 25,
  dieselPrice: 1.75,
}

const DEFAULT_ROUTE_SUMMARY: RouteSummary = {
  loadedDistanceKm: 0,
  deadheadDistanceKm: 0,
  driveTimeMinutes: 0,
  loadedCost: 0,
  deadheadCost: 0,
  minimumChargeAdjustment: 0,
  subtotal: 0,
  gst: 0,
  total: 0,
}

const GOOGLE_MAPS_API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '').trim()
let googleMapsLoadPromise: Promise<void> | null = null
let googlePlacesLibrary: GooglePlacesLibrary | null = null
let googleSessionToken: object | null = null

const ensureGoogleMapsReady = async () => {
  if (googlePlacesLibrary?.AutocompleteSuggestion) {
    return
  }

  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Missing VITE_GOOGLE_MAPS_API_KEY')
  }

  if (googleMapsLoadPromise) {
    await googleMapsLoadPromise
    return
  }

  googleMapsLoadPromise = (async () => {
    setOptions({
      key: GOOGLE_MAPS_API_KEY,
      libraries: ['places'],
      language: 'en',
      region: 'CA',
    })

    await importLibrary('maps')
    googlePlacesLibrary = await importLibrary('places') as unknown as GooglePlacesLibrary

    if (!googlePlacesLibrary.AutocompleteSuggestion) {
      throw new Error('Google Places failed to initialize')
    }
  })()

  try {
    await googleMapsLoadPromise
  } catch (error) {
    googleMapsLoadPromise = null
    throw error
  }
}


const getSessionToken = () => {
  if (!googlePlacesLibrary?.AutocompleteSessionToken) {
    return null
  }

  if (!googleSessionToken) {
    googleSessionToken = new googlePlacesLibrary.AutocompleteSessionToken()
  }

  return googleSessionToken
}

const fetchAddressSuggestions = async (query: string) => {
  const trimmed = query.trim()

  console.log('[places] fetchAddressSuggestions', {
    trimmed,
    hasAutocompleteSuggestion: !!googlePlacesLibrary?.AutocompleteSuggestion,
  })

  if (!trimmed || trimmed.length < 2) {
    return []
  }

  if (googlePlacesLibrary?.AutocompleteSuggestion) {
    try {
      const response = await googlePlacesLibrary.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: trimmed,
        includedRegionCodes: ['ca'],
        sessionToken: getSessionToken(),
      })
      const predictions = response.suggestions
        .map((suggestion) => suggestion.placePrediction?.text?.text ?? '')
        .filter(Boolean)
      console.log('[places] raw Google response', {
        query: trimmed,
        count: predictions.length,
        first: predictions[0] ?? null,
      })
      return predictions
    } catch (error) {
      console.error('[places] AutocompleteSuggestion failed', error)
      return []
    }
  }

  return []
}

const resolvePlaceAddress = async (query: string) => {
  const trimmed = query.trim()
  if (!trimmed) {
    return ''
  }

  const predictions = await fetchAddressSuggestions(trimmed)
  return predictions[0] ?? trimmed
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: 2,
  }).format(amount)

const formatKm = (value: number) => `${value.toFixed(1)} km`

const formatDriveTime = (minutes: number) => {
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60

  if (hours > 0) {
    return `${hours} hr ${remainingMinutes} min`
  }

  return `${remainingMinutes} min`
}

const haversineKm = (
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
) => {
  const toRad = (value: number) => (value * Math.PI) / 180
  const earthRadius = 6371
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return earthRadius * c
}

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const geocodeAddress = async (address: string) => {
  if (GOOGLE_MAPS_API_KEY) {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`,
    )

    if (!response.ok) {
      return null
    }

    const payload = await response.json()
    const result = payload.results?.[0]

    if (!result) {
      return null
    }

    return {
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
    }
  }

  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`,
  )

  if (!response.ok) {
    return null
  }

  const data = (await response.json()) as Array<{ lat: string; lon: string }>
  const result = data[0]

  if (!result) {
    return null
  }

  return {
    lat: Number(result.lat),
    lng: Number(result.lon),
  }
}

const getGoogleRouteSummary = async (origin: string, destination: string) => {
  if (!GOOGLE_MAPS_API_KEY) {
    return null
  }

  const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
    },
    body: JSON.stringify({
      origin: { address: origin },
      destination: { address: destination },
      travelMode: 'DRIVE',
    }),
  })

  if (!response.ok) {
    return null
  }

  const payload = (await response.json()) as {
    routes?: Array<{ distanceMeters?: number; duration?: string }> 
  }
  const route = payload.routes?.[0]

  if (!route) {
    return null
  }

  const durationSeconds = Number.parseInt(route.duration ?? '0', 10)

  return {
    distanceKm: (route.distanceMeters ?? 0) / 1000,
    durationMinutes: Math.round(durationSeconds / 60),
  }
}

const buildQuoteNumber = (quotes: QuoteRecord[]) => {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const todaysQuotes = quotes.filter((quote) => quote.quoteNumber.includes(`FWF-${today}-`))
  const sequence = String(todaysQuotes.length + 1).padStart(3, '0')
  return `FWF-${today}-${sequence}`
}

const calculateSummary = async (
  pickup: string,
  dropoff: string,
  settings: Settings,
): Promise<RouteSummary> => {
  if (!pickup || !dropoff) {
    return DEFAULT_ROUTE_SUMMARY
  }

  try {
    const [yardCoords, pickupCoords, dropoffCoords] = await Promise.all([
      geocodeAddress(settings.yardAddress),
      geocodeAddress(pickup),
      geocodeAddress(dropoff),
    ])

    if (!yardCoords || !pickupCoords || !dropoffCoords) {
      return DEFAULT_ROUTE_SUMMARY
    }

    let deadheadKm = haversineKm(
      yardCoords.lat,
      yardCoords.lng,
      pickupCoords.lat,
      pickupCoords.lng,
    )
    let loadedKm = haversineKm(
      pickupCoords.lat,
      pickupCoords.lng,
      dropoffCoords.lat,
      dropoffCoords.lng,
    )
    let returnDeadheadKm = haversineKm(
      dropoffCoords.lat,
      dropoffCoords.lng,
      yardCoords.lat,
      yardCoords.lng,
    )
    let driveTimeMinutes = Math.round((deadheadKm + loadedKm + returnDeadheadKm) / 0.75)

    const googleRouteDeadhead = await getGoogleRouteSummary(settings.yardAddress, pickup)
    const googleRouteLoaded = await getGoogleRouteSummary(pickup, dropoff)
    const googleRouteReturn = await getGoogleRouteSummary(dropoff, settings.yardAddress)

    if (googleRouteDeadhead && googleRouteLoaded && googleRouteReturn) {
      deadheadKm = googleRouteDeadhead.distanceKm
      loadedKm = googleRouteLoaded.distanceKm
      returnDeadheadKm = googleRouteReturn.distanceKm
      driveTimeMinutes =
        googleRouteDeadhead.durationMinutes +
        googleRouteLoaded.durationMinutes +
        googleRouteReturn.durationMinutes
    }

    const loadedCost = loadedKm * settings.loadedRate
    const deadheadCost = (deadheadKm + returnDeadheadKm) * settings.deadheadRate
    const baseSubtotal = loadedCost + deadheadCost
    const minimumChargeAdjustment = Math.max(settings.minimumCharge - baseSubtotal, 0)
    const subtotal = Math.max(baseSubtotal, settings.minimumCharge)
    const gst = subtotal * settings.gstRate
    const total = subtotal + gst

    return {
      loadedDistanceKm: loadedKm,
      deadheadDistanceKm: deadheadKm + returnDeadheadKm,
      driveTimeMinutes,
      loadedCost,
      deadheadCost,
      minimumChargeAdjustment,
      subtotal,
      gst,
      total,
    }
  } catch {
    return DEFAULT_ROUTE_SUMMARY
  }
}

function App() {
  const pickupRef = useRef<HTMLInputElement | null>(null)
  const dropoffRef = useRef<HTMLInputElement | null>(null)
  const pickupSuggestionsRequestRef = useRef(0)
  const dropoffSuggestionsRequestRef = useRef(0)

  const [settings, setSettings] = useState<Settings>(() => {
    const stored = readJson<Settings>(STORAGE_KEYS.settings, DEFAULT_SETTINGS)
    return { ...DEFAULT_SETTINGS, ...stored }
  })
  const [quotes, setQuotes] = useState<QuoteRecord[]>(() =>
    readJson<QuoteRecord[]>(STORAGE_KEYS.quotes, []),
  )
  const [recentPickupAddresses, setRecentPickupAddresses] = useState<string[]>(() =>
    readJson<string[]>(STORAGE_KEYS.recentPickup, []),
  )
  const [recentDropoffAddresses, setRecentDropoffAddresses] = useState<string[]>(() =>
    readJson<string[]>(STORAGE_KEYS.recentDropoff, []),
  )
  const [customers] = useState<CustomerRecord[]>(() =>
    readJson<CustomerRecord[]>(STORAGE_KEYS.customers, []),
  )
  const [pickupAddress, setPickupAddress] = useState('')
  const [dropoffAddress, setDropoffAddress] = useState('')
  const [pickupSuggestions, setPickupSuggestions] = useState<string[]>([])
  const [dropoffSuggestions, setDropoffSuggestions] = useState<string[]>([])
  const [pickupSuggestionsVisible, setPickupSuggestionsVisible] = useState(false)
  const [dropoffSuggestionsVisible, setDropoffSuggestionsVisible] = useState(false)
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [loadDescription, setLoadDescription] = useState('')
  const [trailerType, setTrailerType] = useState('')
  const [loadWeightLbs, setLoadWeightLbs] = useState('')
  const [activePage, setActivePage] = useState<'home' | 'history' | 'settings'>('home')
  const [routeSummary, setRouteSummary] = useState<RouteSummary>(DEFAULT_ROUTE_SUMMARY)
  const [searchTerm, setSearchTerm] = useState('')
  const [isCalculating, setIsCalculating] = useState(false)
  const [googleReady, setGoogleReady] = useState(false)
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [isAdditionalDetailsOpen, setIsAdditionalDetailsOpen] = useState(false)
  const [isMoreFuelDetailsOpen, setIsMoreFuelDetailsOpen] = useState(false)
  const [isRecentPickupOpen, setIsRecentPickupOpen] = useState(false)
  const [isRecentDropoffOpen, setIsRecentDropoffOpen] = useState(false)

  const refreshSuggestions = useCallback(
    async (field: 'pickup' | 'dropoff', value: string) => {
      const trimmed = value.trim()
      console.log('[suggestions] input update', {
        field,
        currentValue: trimmed,
        length: trimmed.length,
      })

      const requestRef = field === 'pickup' ? pickupSuggestionsRequestRef : dropoffSuggestionsRequestRef
      const requestId = ++requestRef.current

      if (!trimmed) {
        if (field === 'pickup') {
          setPickupSuggestions([])
          setPickupSuggestionsVisible(false)
        } else {
          setDropoffSuggestions([])
          setDropoffSuggestionsVisible(false)
        }

        console.log('[suggestions] cleared due to empty query', {
          field,
          currentValue: trimmed,
          dropdownVisible: false,
        })
        return
      }

      const predictions = await fetchAddressSuggestions(trimmed)
      console.log('[suggestions] prediction callback', {
        field,
        currentValue: trimmed,
        count: predictions.length,
        predictions,
      })

      if (requestId !== requestRef.current) {
        console.log('[suggestions] stale response ignored', {
          field,
          currentValue: trimmed,
          requestId,
          latestRequestId: requestRef.current,
        })
        return
      }

      if (field === 'pickup') {
        setPickupSuggestions(predictions)
        setPickupSuggestionsVisible(predictions.length > 0)
      } else {
        setDropoffSuggestions(predictions)
        setDropoffSuggestionsVisible(predictions.length > 0)
      }

      console.log('[suggestions] dropdown visible state', {
        field,
        currentValue: trimmed,
        dropdownVisible: field === 'pickup' ? pickupSuggestionsVisible : dropoffSuggestionsVisible,
        count: predictions.length,
      })
    },
    [pickupSuggestionsVisible, dropoffSuggestionsVisible],
  )

  const applyAddressValue = useCallback(
    (field: 'pickup' | 'dropoff', nextValue: string) => {
      if (field === 'pickup') {
        setPickupAddress(nextValue)
        void refreshSuggestions('pickup', nextValue)
        return
      }

      setDropoffAddress(nextValue)
      void refreshSuggestions('dropoff', nextValue)
    },
    [refreshSuggestions],
  )

  const internalBusinessSummary = useMemo(() => {
    const deadheadFuelUsed = (routeSummary.deadheadDistanceKm / 100) * settings.deadheadFuelEconomy
    const loadedFuelUsed = (routeSummary.loadedDistanceKm / 100) * settings.loadedFuelEconomy
    const totalFuelUsed = deadheadFuelUsed + loadedFuelUsed
    const estimatedFuelCost = totalFuelUsed * settings.dieselPrice
    const estimatedGrossProfit = routeSummary.subtotal - estimatedFuelCost

    return {
      deadheadFuelUsed,
      loadedFuelUsed,
      totalFuelUsed,
      estimatedFuelCost,
      estimatedGrossProfit,
    }
  }, [routeSummary, settings])

  const suggestedCustomers = useMemo(() => {
    const trimmed = customerName.trim().toLowerCase()
    if (!trimmed) {
      return []
    }

    return customers.filter((customer) =>
      customer.name.toLowerCase().includes(trimmed),
    )
  }, [customerName, customers])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.quotes, JSON.stringify(quotes))
  }, [quotes])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.recentPickup, JSON.stringify(recentPickupAddresses))
  }, [recentPickupAddresses])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.recentDropoff, JSON.stringify(recentDropoffAddresses))
  }, [recentDropoffAddresses])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.customers, JSON.stringify(customers))
  }, [customers])

  useEffect(() => {
    const loadGoogle = async () => {
      console.log('[google] loadGoogle start', {
        hasKey: !!GOOGLE_MAPS_API_KEY,
        hasPlacesLibrary: !!googlePlacesLibrary,
      })

      if (!GOOGLE_MAPS_API_KEY) {
        console.log('[google] missing API key')
        setGoogleReady(false)
        return
      }

      try {
        await ensureGoogleMapsReady()

        console.log('[google] script ready', {
          hasPlacesLibrary: !!googlePlacesLibrary,
          hasAutocompleteSuggestion: !!googlePlacesLibrary?.AutocompleteSuggestion,
        })

        const validationResponse = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(settings.yardAddress)}&key=${GOOGLE_MAPS_API_KEY}`,
        )
        const validationPayload = await validationResponse.json()
        const validationStatus = validationPayload?.status
        console.log('[google] validation check', { validationStatus, ok: validationResponse.ok })

        if (!validationResponse.ok || validationStatus !== 'OK') {
          console.error('[google] Google Places validation failed', validationPayload)
          setGoogleReady(false)
          return
        }

        setGoogleReady(true)
      } catch (error) {
        console.error('[google] loadGoogle failed', error)
        setGoogleReady(false)
      }
    }

    void loadGoogle()
  }, [settings.yardAddress])

  useEffect(() => {
    console.log('[input] stable input refs mounted', {
      pickupSame: pickupRef.current === document.getElementById('pickup-address-input'),
      dropoffSame: dropoffRef.current === document.getElementById('dropoff-address-input'),
      googleReady,
    })
  }, [googleReady])

  useEffect(() => {
    if (activePage !== 'home') {
      return undefined
    }

    let active = true

    const initialize = async () => {
      try {
        await ensureGoogleMapsReady()
      } catch (error) {
        console.error('[google] Home initialization failed', error)
        if (active) {
          setGoogleReady(false)
        }
        return
      }

      if (active) {
        setGoogleReady(true)
      }
    }

    void initialize()

    return () => {
      active = false
    }
  }, [activePage])

  useEffect(() => {
    const updateSummary = async () => {
      setIsCalculating(true)
      const summary = await calculateSummary(pickupAddress, dropoffAddress, settings)
      setRouteSummary(summary)
      setIsCalculating(false)
    }

    updateSummary().catch(() => setIsCalculating(false))
  }, [pickupAddress, dropoffAddress, settings])

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPromptEvent(event as BeforeInstallPromptEvent)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  }, [])

  const filteredQuotes = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) {
      return quotes
    }

    return quotes.filter((quote) =>
      [
        quote.quoteNumber,
        quote.customer,
        quote.pickup,
        quote.dropoff,
        quote.loadDescription,
        quote.trailerType,
        quote.notes ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [quotes, searchTerm])

  const voiceCapture = async (setter: (value: string) => void, type: 'pickup' | 'dropoff') => {
    const recognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition
    console.log('[voice] capture start', {
      hasRecognition: !!recognitionCtor,
      hasMediaDevices: !!navigator.mediaDevices?.getUserMedia,
      microphonePermission: navigator.permissions ? 'available' : 'unavailable',
    })

    if (!recognitionCtor) {
      console.log('[voice] speech recognition API missing')
      window.alert('Voice input is not available in this browser.')
      return
    }

    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const permission = navigator.permissions?.query
          ? await navigator.permissions.query({ name: 'microphone' as PermissionName }).catch(() => null)
          : null
        console.log('[voice] microphone permission', permission?.state ?? 'not-queryable')

        if (permission?.state === 'denied') {
          window.alert('Microphone access is required for voice input.')
          return
        }

        await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (error) {
        console.error('[voice] microphone permission denied', error)
        window.alert('Microphone access is required for voice input.')
        return
      }
    }

    const recognition = new recognitionCtor()
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onresult = async (event) => {
      const transcript = event.results[0][0].transcript.trim()
      console.log('[voice] transcript received', { transcript })
      if (!transcript) {
        return
      }

      const resolvedAddress = await resolvePlaceAddress(transcript)
      setter(resolvedAddress)
      addRecentAddress(resolvedAddress, type)
    }
    recognition.onerror = (event: { error?: string }) => {
      const error = event?.error ?? 'unknown'
      console.error('[voice] recognition error', error)
      if (error === 'not-allowed' || error === 'service-not-allowed' || error === 'audio-capture') {
        window.alert('Microphone access is required for voice input.')
        return
      }

      window.alert('Unable to capture speech right now. Please try again.')
    }
    recognition.onstart = () => {
      console.log('[voice] recognition started')
    }
    try {
      recognition.start()
    } catch (error) {
      console.error('[voice] recognition.start failed', error)
      window.alert('Unable to capture speech right now. Please try again.')
    }
  }

  const addRecentAddress = (address: string, type: 'pickup' | 'dropoff') => {
    const trimmedAddress = address.trim()
    if (!trimmedAddress) {
      return
    }

    if (type === 'pickup') {
      setRecentPickupAddresses((current) =>
        [trimmedAddress, ...current.filter((entry) => entry !== trimmedAddress)].slice(0, 20),
      )
      return
    }

    setRecentDropoffAddresses((current) =>
      [trimmedAddress, ...current.filter((entry) => entry !== trimmedAddress)].slice(0, 20),
    )
  }

  const swapAddresses = () => {
    const previousPickup = pickupAddress
    setPickupAddress(dropoffAddress)
    setDropoffAddress(previousPickup)
  }

  const applyCustomerSuggestion = (customer: CustomerRecord) => {
    setCustomerName(customer.name)
    setCustomerPhone(customer.phone)
    setCustomerEmail(customer.email)
    setNotes(customer.notes)
  }

  const quoteText = (quote: QuoteRecord) =>
    [
      `Quote: ${quote.quoteNumber}`,
      `Customer: ${quote.customer}`,
      `Phone: ${quote.customerPhone || '—'}`,
      `Email: ${quote.customerEmail || '—'}`,
      `Pickup: ${quote.pickup}`,
      `Drop-off: ${quote.dropoff}`,
      `Loaded Distance: ${formatKm(quote.loadedKm)}`,
      `Deadhead Distance: ${formatKm(quote.deadheadKm)}`,
      `Drive Time: ${quote.driveTime}`,
      `Loaded Cost: ${formatCurrency(quote.loadedCost)}`,
      `Deadhead Cost: ${formatCurrency(quote.deadheadCost)}`,
      `Minimum Charge Adjustment: ${formatCurrency(quote.minimumChargeAdjustment)}`,
      `Subtotal: ${formatCurrency(quote.subtotal)}`,
      `GST: ${formatCurrency(quote.gst)}`,
      `Grand Total: ${formatCurrency(quote.total)}`,
    ].join('\n')

  const copyQuote = async (quote?: QuoteRecord) => {
    const selected = quote ?? {
      quoteNumber: buildQuoteNumber(quotes),
      customer: customerName || 'Walk-in',
      customerPhone,
      customerEmail,
      pickup: pickupAddress,
      dropoff: dropoffAddress,
      loadDescription,
      trailerType,
      loadWeightLbs,
      loadedKm: Number(routeSummary.loadedDistanceKm.toFixed(1)),
      deadheadKm: Number(routeSummary.deadheadDistanceKm.toFixed(1)),
      driveTime: `${routeSummary.driveTimeMinutes} min`,
      loadedCost: Number(routeSummary.loadedCost.toFixed(2)),
      deadheadCost: Number(routeSummary.deadheadCost.toFixed(2)),
      minimumChargeAdjustment: Number(routeSummary.minimumChargeAdjustment.toFixed(2)),
      subtotal: Number(routeSummary.subtotal.toFixed(2)),
      gst: Number(routeSummary.gst.toFixed(2)),
      total: Number(routeSummary.total.toFixed(2)),
      notes,
      createdAt: new Date().toISOString(),
    }

    await navigator.clipboard.writeText(quoteText(selected))
  }

  const shareQuote = async (quote?: QuoteRecord) => {
    const selected = quote ?? {
      quoteNumber: buildQuoteNumber(quotes),
      customer: customerName || 'Walk-in',
      customerPhone,
      customerEmail,
      pickup: pickupAddress,
      dropoff: dropoffAddress,
      loadDescription,
      trailerType,
      loadWeightLbs,
      loadedKm: Number(routeSummary.loadedDistanceKm.toFixed(1)),
      deadheadKm: Number(routeSummary.deadheadDistanceKm.toFixed(1)),
      driveTime: `${routeSummary.driveTimeMinutes} min`,
      loadedCost: Number(routeSummary.loadedCost.toFixed(2)),
      deadheadCost: Number(routeSummary.deadheadCost.toFixed(2)),
      minimumChargeAdjustment: Number(routeSummary.minimumChargeAdjustment.toFixed(2)),
      subtotal: Number(routeSummary.subtotal.toFixed(2)),
      gst: Number(routeSummary.gst.toFixed(2)),
      total: Number(routeSummary.total.toFixed(2)),
      notes,
      createdAt: new Date().toISOString(),
    }

    if (!navigator.share) {
      await navigator.clipboard.writeText(quoteText(selected))
      return
    }

    await navigator.share({
      title: `Quote ${selected.quoteNumber}`,
      text: quoteText(selected),
    })
  }

  const duplicateQuote = (quote: QuoteRecord) => {
    const duplicatedQuote: QuoteRecord = {
      ...quote,
      quoteNumber: buildQuoteNumber(quotes),
      createdAt: new Date().toISOString(),
    }

    setQuotes((current) => [duplicatedQuote, ...current])
  }

  const deleteQuote = (quoteNumber: string) => {
    setQuotes((current) => current.filter((quote) => quote.quoteNumber !== quoteNumber))
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6 lg:px-8">
        <header className="mb-3 flex items-center justify-between rounded-2xl bg-white px-3 py-2 shadow-sm ring-1 ring-stone-200">
          <div className="flex items-center gap-2">
            <div className="rounded-full bg-amber-900/10 p-2 text-amber-900">
              <TruckIcon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-stone-500">FWF</p>
              <h1 className="text-sm font-bold text-stone-900">Hauling Companion</h1>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setActivePage('settings')}
            className="rounded-full bg-stone-100 p-2 text-stone-700"
            aria-label="Open settings"
          >
            <Cog6ToothIcon className="h-5 w-5" />
          </button>
        </header>

        {activePage === 'home' && (
          <>
            <div className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
              <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
              <div className="grid gap-3">
                <div className="relative grid gap-2">
                  <div className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                    <label className="mb-2 block text-sm font-semibold">Pickup Address</label>
                    <div className="relative">
                      <input
                        key="pickup-address-input"
                        id="pickup-address-input"
                        ref={pickupRef}
                        autoComplete="off"
                        list="pickup-suggestions"
                        value={pickupAddress}
                        onInput={(event) => {
                          const nextValue = event.currentTarget.value
                          applyAddressValue('pickup', nextValue)
                        }}
                        onFocus={() => {
                          void refreshSuggestions('pickup', pickupAddress)
                        }}
                        onBlur={() => {
                          window.setTimeout(() => {
                            setPickupSuggestionsVisible(false)
                          }, 120)
                          addRecentAddress(pickupAddress, 'pickup')
                        }}
                        placeholder="Enter pickup address"
                        className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 pr-12 outline-none transition focus:border-amber-700"
                      />
                      {pickupSuggestionsVisible && pickupSuggestions.length > 0 && (
                        <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-xl ring-1 ring-stone-100">
                          {pickupSuggestions.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setPickupAddress(suggestion)
                                setPickupSuggestions([])
                                setPickupSuggestionsVisible(false)
                                addRecentAddress(suggestion, 'pickup')
                              }}
                              className="block w-full border-b border-stone-100 px-4 py-3 text-left text-sm text-stone-700 last:border-b-0 hover:bg-stone-50"
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => voiceCapture(setPickupAddress, 'pickup')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-amber-900 p-2 text-white"
                      >
                        <MicrophoneIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                    <label className="mb-2 block text-sm font-semibold">Drop-off Address</label>
                    <div className="relative">
                      <input
                        key="dropoff-address-input"
                        id="dropoff-address-input"
                        ref={dropoffRef}
                        autoComplete="off"
                        list="dropoff-suggestions"
                        value={dropoffAddress}
                        onInput={(event) => {
                          const nextValue = event.currentTarget.value
                          applyAddressValue('dropoff', nextValue)
                        }}
                        onFocus={() => {
                          void refreshSuggestions('dropoff', dropoffAddress)
                        }}
                        onBlur={() => {
                          window.setTimeout(() => {
                            setDropoffSuggestionsVisible(false)
                          }, 120)
                          addRecentAddress(dropoffAddress, 'dropoff')
                        }}
                        placeholder="Enter drop-off address"
                        className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 pr-12 outline-none transition focus:border-amber-700"
                      />
                      {dropoffSuggestionsVisible && dropoffSuggestions.length > 0 && (
                        <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-xl ring-1 ring-stone-100">
                          {dropoffSuggestions.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setDropoffAddress(suggestion)
                                setDropoffSuggestions([])
                                setDropoffSuggestionsVisible(false)
                                addRecentAddress(suggestion, 'dropoff')
                              }}
                              className="block w-full border-b border-stone-100 px-4 py-3 text-left text-sm text-stone-700 last:border-b-0 hover:bg-stone-50"
                            >
                              {suggestion}
                            </button>
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => voiceCapture(setDropoffAddress, 'dropoff')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-amber-900 p-2 text-white"
                      >
                        <MicrophoneIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={swapAddresses}
                    className="absolute right-[-6px] top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-stone-900 text-white shadow-lg ring-2 ring-white"
                    aria-label="Swap pickup and drop-off addresses"
                  >
                    <ArrowsUpDownIcon className="h-4 w-4" />
                  </button>
                </div>

                <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-stone-900">Quote Summary</p>
                      <p className="text-xs text-stone-500">Hidden yard routing included</p>
                    </div>
                    <div className="rounded-full bg-stone-100 px-3 py-1 text-xs font-bold text-stone-700">
                      {isCalculating ? 'Calculating…' : 'Ready'}
                    </div>
                  </div>

                  <div className="grid gap-3 rounded-2xl bg-stone-50 p-3">
                    <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2">
                      <span className="text-sm text-stone-600">Loaded Distance</span>
                      <span className="font-semibold">{formatKm(routeSummary.loadedDistanceKm)}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2">
                      <span className="text-sm text-stone-600">Deadhead Distance</span>
                      <span className="font-semibold">{formatKm(routeSummary.deadheadDistanceKm)}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2">
                      <span className="text-sm text-stone-600">Estimated Drive Time</span>
                      <span className="font-semibold">{formatDriveTime(routeSummary.driveTimeMinutes)}</span>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-stone-600">Subtotal</span>
                        <span className="text-lg font-extrabold text-amber-900">{formatCurrency(routeSummary.subtotal)}</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2">
                      <span className="text-sm text-stone-600">GST</span>
                      <span className="font-semibold">{formatCurrency(routeSummary.gst)}</span>
                    </div>
                    <div className="my-1 h-px w-full bg-stone-300" />
                    <div className="flex items-center justify-between rounded-2xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
                      <span className="text-base font-bold text-stone-800">Grand Total</span>
                      <span className="text-2xl font-black text-amber-900">{formatCurrency(routeSummary.total)}</span>
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-200">
                    <p className="text-sm font-bold text-amber-900">Internal Business Information</p>
                    <p className="mt-1 text-xs text-amber-800">This information is for FWF Hauling only.</p>
                    <div className="mt-3 grid gap-2 rounded-xl bg-white p-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-stone-600">Estimated Fuel Cost</span>
                        <span className="font-semibold">{formatCurrency(internalBusinessSummary.estimatedFuelCost)}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-stone-600">Estimated Gross Profit</span>
                        <span className="font-semibold">{formatCurrency(internalBusinessSummary.estimatedGrossProfit)}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsMoreFuelDetailsOpen((current) => !current)}
                      className="mt-3 flex w-full items-center justify-between rounded-xl bg-white px-3 py-2 text-sm font-semibold text-stone-800"
                    >
                      <span>More Details</span>
                      {isMoreFuelDetailsOpen ? (
                        <ChevronUpIcon className="h-4 w-4" />
                      ) : (
                        <ChevronDownIcon className="h-4 w-4" />
                      )}
                    </button>
                    {isMoreFuelDetailsOpen && (
                      <div className="mt-2 grid gap-2 rounded-xl bg-white p-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-stone-600">Deadhead Fuel Used</span>
                          <span className="font-semibold">{internalBusinessSummary.deadheadFuelUsed.toFixed(2)} L</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-stone-600">Loaded Fuel Used</span>
                          <span className="font-semibold">{internalBusinessSummary.loadedFuelUsed.toFixed(2)} L</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-stone-600">Total Fuel Used</span>
                          <span className="font-semibold">{internalBusinessSummary.totalFuelUsed.toFixed(2)} L</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => copyQuote()}
                      className="rounded-2xl bg-stone-900 px-4 py-3 text-sm font-semibold text-white"
                    >
                      Copy Quote
                    </button>
                    <button
                      type="button"
                      onClick={() => shareQuote()}
                      className="rounded-2xl bg-stone-200 px-4 py-3 text-sm font-semibold text-stone-800"
                    >
                      Share Quote
                    </button>
                  </div>
                </section>

                <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
                  <button
                    type="button"
                    onClick={() => setIsAdditionalDetailsOpen((current) => !current)}
                    className="flex w-full items-center justify-between rounded-2xl bg-stone-100 px-3 py-3 text-left"
                  >
                    <span className="text-sm font-semibold text-stone-900">Additional Details</span>
                    {isAdditionalDetailsOpen ? (
                      <ChevronUpIcon className="h-5 w-5 text-stone-700" />
                    ) : (
                      <ChevronDownIcon className="h-5 w-5 text-stone-700" />
                    )}
                  </button>

                  {isAdditionalDetailsOpen && (
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                        <span className="mb-2 block text-sm font-semibold">Customer Name</span>
                        <input
                          value={customerName}
                          onChange={(event) => setCustomerName(event.target.value)}
                          placeholder="Customer name"
                          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none transition focus:border-amber-700"
                        />
                        {suggestedCustomers.length > 0 && (
                          <div className="mt-2 rounded-2xl bg-white p-2 shadow-sm ring-1 ring-stone-200">
                            {suggestedCustomers.slice(0, 4).map((customer) => (
                              <button
                                key={`${customer.name}-${customer.phone}`}
                                type="button"
                                onClick={() => applyCustomerSuggestion(customer)}
                                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm hover:bg-stone-100"
                              >
                                <span>{customer.name}</span>
                                <span className="text-stone-500">{customer.phone || customer.email || 'Saved'}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </label>

                      <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                        <span className="mb-2 block text-sm font-semibold">Customer Phone</span>
                        <input
                          value={customerPhone}
                          onChange={(event) => setCustomerPhone(event.target.value)}
                          placeholder="Optional"
                          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none transition focus:border-amber-700"
                        />
                      </label>

                      <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                        <span className="mb-2 block text-sm font-semibold">Customer Email</span>
                        <input
                          type="email"
                          value={customerEmail}
                          onChange={(event) => setCustomerEmail(event.target.value)}
                          placeholder="Optional"
                          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none transition focus:border-amber-700"
                        />
                      </label>

                      <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                        <span className="mb-2 block text-sm font-semibold">Notes</span>
                        <textarea
                          value={notes}
                          onChange={(event) => setNotes(event.target.value)}
                          placeholder="Optional"
                          rows={3}
                          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none transition focus:border-amber-700"
                        />
                      </label>

                      <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                        <span className="mb-2 block text-sm font-semibold">Trailer Type</span>
                        <input
                          value={trailerType}
                          onChange={(event) => setTrailerType(event.target.value)}
                          placeholder="Optional"
                          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none transition focus:border-amber-700"
                        />
                      </label>

                      <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                        <span className="mb-2 block text-sm font-semibold">Load Weight (lbs)</span>
                        <input
                          type="number"
                          value={loadWeightLbs}
                          onChange={(event) => setLoadWeightLbs(event.target.value)}
                          placeholder="Optional"
                          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none transition focus:border-amber-700"
                        />
                      </label>

                      <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200 sm:col-span-2">
                        <span className="mb-2 block text-sm font-semibold">Load Description</span>
                        <input
                          value={loadDescription}
                          onChange={(event) => setLoadDescription(event.target.value)}
                          placeholder="Optional"
                          className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none transition focus:border-amber-700"
                        />
                      </label>
                    </div>
                  )}
                </section>

                <div className="mt-3 grid gap-2">
                  <div className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                    <button
                      type="button"
                      onClick={() => setIsRecentPickupOpen((current) => !current)}
                      className="flex w-full items-center justify-between rounded-2xl bg-white px-3 py-2 text-left"
                    >
                      <span className="text-sm font-semibold text-stone-900">Recent Pickup Addresses</span>
                      {isRecentPickupOpen ? (
                        <ChevronUpIcon className="h-4 w-4 text-stone-700" />
                      ) : (
                        <ChevronDownIcon className="h-4 w-4 text-stone-700" />
                      )}
                    </button>
                    {isRecentPickupOpen && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {recentPickupAddresses.map((address) => (
                          <button
                            key={address}
                            type="button"
                            onClick={() => {
                              setPickupAddress(address)
                              addRecentAddress(address, 'pickup')
                            }}
                            className="rounded-full bg-stone-200 px-3 py-1 text-xs font-medium"
                          >
                            {address}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                    <button
                      type="button"
                      onClick={() => setIsRecentDropoffOpen((current) => !current)}
                      className="flex w-full items-center justify-between rounded-2xl bg-white px-3 py-2 text-left"
                    >
                      <span className="text-sm font-semibold text-stone-900">Recent Drop-off Addresses</span>
                      {isRecentDropoffOpen ? (
                        <ChevronUpIcon className="h-4 w-4 text-stone-700" />
                      ) : (
                        <ChevronDownIcon className="h-4 w-4 text-stone-700" />
                      )}
                    </button>
                    {isRecentDropoffOpen && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {recentDropoffAddresses.map((address) => (
                          <button
                            key={address}
                            type="button"
                            onClick={() => {
                              setDropoffAddress(address)
                              addRecentAddress(address, 'dropoff')
                            }}
                            className="rounded-full bg-stone-200 px-3 py-1 text-xs font-medium"
                          >
                            {address}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            <aside className="space-y-4">
              <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
                <div className="mb-3 flex items-center gap-2 rounded-2xl bg-stone-100 p-3">
                  <BuildingOffice2Icon className="h-5 w-5 text-amber-900" />
                  <div>
                    <p className="text-sm font-semibold text-stone-900">Yard Location</p>
                    <p className="text-xs text-stone-500">Fixed and hidden from the quote view</p>
                  </div>
                </div>
                <p className="rounded-2xl bg-stone-50 px-3 py-4 text-sm text-stone-700">{settings.yardAddress}</p>
              </section>
            </aside>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => (installPromptEvent ? installPromptEvent.prompt() : undefined)}
                className="rounded-full bg-amber-900 px-4 py-2 text-sm font-semibold text-white"
              >
                Install App
              </button>
              {googleReady && (
                <span className="rounded-full bg-emerald-100 px-3 py-2 text-xs font-semibold text-emerald-700">
                  Google Places ready
                </span>
              )}
            </div>
          </>
        )}

        {activePage === 'history' && (
          <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-stone-900">Quote History</p>
                <p className="text-xs text-stone-500">Every quote is stored locally for offline access</p>
              </div>
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search quotes"
                className="w-full rounded-2xl border border-stone-300 bg-stone-50 px-4 py-3 outline-none sm:max-w-xs"
              />
            </div>

            <div className="grid gap-3">
              {filteredQuotes.map((quote) => (
                <article key={quote.quoteNumber} className="rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-bold text-stone-900">{quote.quoteNumber}</p>
                      <p className="text-sm text-stone-700">Customer: {quote.customer}</p>
                      <p className="text-sm text-stone-700">Pickup: {quote.pickup}</p>
                      <p className="text-sm text-stone-700">Drop-off: {quote.dropoff}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => duplicateQuote(quote)}
                        className="rounded-full bg-stone-900 px-3 py-2 text-xs font-semibold text-white"
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        onClick={() => copyQuote(quote)}
                        className="rounded-full bg-stone-900 px-3 py-2 text-xs font-semibold text-white"
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        onClick={() => shareQuote(quote)}
                        className="rounded-full bg-stone-200 px-3 py-2 text-xs font-semibold text-stone-800"
                      >
                        Share
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteQuote(quote.quoteNumber)}
                        className="rounded-full bg-rose-100 px-3 py-2 text-xs font-semibold text-rose-700"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 text-sm text-stone-700 sm:grid-cols-3">
                    <span>Loaded km: {quote.loadedKm}</span>
                    <span>Deadhead km: {quote.deadheadKm}</span>
                    <span>Drive time: {quote.driveTime}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-sm font-semibold text-stone-900">
                    <span>Loaded Cost: {formatCurrency(quote.loadedCost)}</span>
                    <span>Deadhead Cost: {formatCurrency(quote.deadheadCost)}</span>
                    <span>Subtotal: {formatCurrency(quote.subtotal)}</span>
                    <span>GST: {formatCurrency(quote.gst)}</span>
                    <span>Total: {formatCurrency(quote.total)}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <nav className="sticky bottom-3 mt-4 grid grid-cols-3 gap-2 rounded-2xl bg-white p-2 shadow-sm ring-1 ring-stone-200">
          <button
            type="button"
            onClick={() => setActivePage('home')}
            className={`flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-[11px] font-semibold ${
              activePage === 'home' ? 'bg-amber-900 text-white' : 'text-stone-700'
            }`}
          >
            <HomeIcon className="h-4 w-4" />
            Home
          </button>
          <button
            type="button"
            onClick={() => setActivePage('history')}
            className={`flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-[11px] font-semibold ${
              activePage === 'history' ? 'bg-amber-900 text-white' : 'text-stone-700'
            }`}
          >
            <ClockIcon className="h-4 w-4" />
            History
          </button>
          <button
            type="button"
            onClick={() => setActivePage('settings')}
            className={`flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-[11px] font-semibold ${
              activePage === 'settings' ? 'bg-amber-900 text-white' : 'text-stone-700'
            }`}
          >
            <Cog6ToothIcon className="h-4 w-4" />
            Settings
          </button>
        </nav>

        {activePage === 'settings' && (
          <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-stone-900">Settings</p>
                <p className="text-xs text-stone-500">Edit rates, company details, and yard policy locally</p>
              </div>
              <PencilSquareIcon className="h-5 w-5 text-amber-900" />
            </div>

            {!GOOGLE_MAPS_API_KEY && (
              <div className="mb-4 rounded-2xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
                Google Places autocomplete is not configured yet. Add <span className="font-semibold">VITE_GOOGLE_MAPS_API_KEY</span> to your environment to enable address suggestions and route lookups. Manual typing, quote history, and local settings still work normally.
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <span className="mb-2 block text-sm font-semibold">Loaded Rate</span>
                <input
                  type="number"
                  step="0.01"
                  value={settings.loadedRate}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, loadedRate: Number(event.target.value) }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <span className="mb-2 block text-sm font-semibold">Deadhead Rate</span>
                <input
                  type="number"
                  step="0.01"
                  value={settings.deadheadRate}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, deadheadRate: Number(event.target.value) }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <span className="mb-2 block text-sm font-semibold">GST</span>
                <input
                  type="number"
                  step="0.01"
                  value={settings.gstRate}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, gstRate: Number(event.target.value) }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <span className="mb-2 block text-sm font-semibold">Minimum Charge</span>
                <input
                  type="number"
                  step="0.01"
                  value={settings.minimumCharge}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, minimumCharge: Number(event.target.value) }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200 sm:col-span-2">
                <span className="mb-2 block text-sm font-semibold">Yard Address</span>
                <input
                  value={settings.yardAddress}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, yardAddress: event.target.value }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <span className="mb-2 block text-sm font-semibold">Deadhead Fuel Economy (L/100 km)</span>
                <input
                  type="number"
                  step="0.1"
                  value={settings.deadheadFuelEconomy}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, deadheadFuelEconomy: Number(event.target.value) }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <span className="mb-2 block text-sm font-semibold">Loaded Fuel Economy (L/100 km)</span>
                <input
                  type="number"
                  step="0.1"
                  value={settings.loadedFuelEconomy}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, loadedFuelEconomy: Number(event.target.value) }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <span className="mb-2 block text-sm font-semibold">Diesel Price ($/L)</span>
                <input
                  type="number"
                  step="0.01"
                  value={settings.dieselPrice}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, dieselPrice: Number(event.target.value) }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <span className="mb-2 block text-sm font-semibold">Company Name</span>
                <input
                  value={settings.companyName}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, companyName: event.target.value }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <span className="mb-2 block text-sm font-semibold">Company Phone</span>
                <input
                  value={settings.companyPhone}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, companyPhone: event.target.value }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <span className="mb-2 block text-sm font-semibold">Company Email</span>
                <input
                  type="email"
                  value={settings.companyEmail}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, companyEmail: event.target.value }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
              <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <span className="mb-2 block text-sm font-semibold">Company GST Number</span>
                <input
                  value={settings.companyGstNumber}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, companyGstNumber: event.target.value }))
                  }
                  className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none"
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSettings(DEFAULT_SETTINGS)}
                className="rounded-2xl bg-stone-200 px-4 py-3 text-sm font-semibold text-stone-800"
              >
                Reset Defaults
              </button>
              <button
                type="button"
                onClick={() => setActivePage('home')}
                className="rounded-2xl bg-amber-900 px-4 py-3 text-sm font-semibold text-white"
              >
                Return to Home
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

export default App
