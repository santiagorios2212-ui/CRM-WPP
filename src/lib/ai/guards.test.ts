import { describe, it, expect } from 'vitest'
import { containsMonetaryAmount } from './guards'

describe('containsMonetaryAmount', () => {
  it.each([
    'El envío cuesta $3.500 dentro de CABA.',
    'Sale $ 80.000 con IVA.',
    'El plan arranca en US$ 29 por mes.',
    'Te lo dejo en U$S50.',
    'Son USD 500 por el desarrollo.',
    'Cuesta ARS1000.',
    'El total es 1.000,50 euros.',
    'Serían 20 dólares mensuales.',
    'Cuesta 500 pesos.',
    '1 dolar por mensaje.',
  ])('flags %j', (text) => {
    expect(containsMonetaryAmount(text)).toBe(true)
  })

  it.each([
    'La reunión de diagnóstico es 100% gratuita.',
    'Respondemos las 24 horas, los 7 días.',
    'No manejamos precios fijos: se cotiza a medida.',
    'Coordinamos una llamada por Google Meet.',
    'Trabajamos con más de 30 empresas.',
    'El agente responde en 2 segundos.',
    'Aceptamos pagos en pesos y en dólares.',
  ])('does not flag %j', (text) => {
    expect(containsMonetaryAmount(text)).toBe(false)
  })
})
