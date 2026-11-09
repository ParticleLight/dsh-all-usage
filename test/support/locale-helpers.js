// The panel resolves its language, formats numbers and looks text up through a
// small helper block near the top of src/client.js (language table, dictionary
// lookup, placeholder formatting). Tests that evaluate a slice of the client in a
// sandbox need that block in scope; assert the markers once here so a future move
// fails with this message instead of a bare `pick is not defined`.
export function localeHelperSource(source) {
  const start = source.indexOf('    const LANGUAGE_ENTRIES')
  const end = source.indexOf('    function uhFixedLayer')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('src/client.js must define the language table and lookup helpers before uhFixedLayer')
  }
  return source.slice(start, end)
}
