import test from 'node:test'
import assert from 'node:assert/strict'

test('service durations compose into a valid end time', () => {
  const start = 10 * 60
  const duration = 120 + 60
  assert.equal(`${Math.floor((start + duration) / 60)}:${String((start + duration) % 60).padStart(2, '0')}`, '13:00')
})

test('adjacent appointments do not overlap', () => {
  const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd
  assert.equal(overlaps(600, 720, 720, 840), false)
  assert.equal(overlaps(600, 720, 690, 840), true)
})
