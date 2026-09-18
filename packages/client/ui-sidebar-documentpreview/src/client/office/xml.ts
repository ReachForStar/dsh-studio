/**
 * XML access for the office renderers.
 *
 * OOXML parts are XML documents whose meaning lives in namespaces and prefixes
 * the producer chose (`w:`, `a:`, `p:`), so every lookup here matches on the
 * local name and ignores the prefix: a document written by another producer
 * must parse without this reader knowing its namespace bindings.
 *
 * Text lives in leaf elements (`w:t`, `a:t`). An edit keeps the element — and
 * therefore the run's formatting — and changes only its content, which is why
 * the helpers work on the parsed document rather than on the source string.
 */

/**
 * One part's parsed document.
 * @param xml - the part's XML source.
 * @param what - the format being read, named in the parse failure.
 * @returns the parsed document, or a thrown error naming the failure.
 */
export function parseXml(xml: string, what: string): XMLDocument {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const failure = doc.querySelector('parsererror')
  if (failure !== null) throw new Error(`${what}: the XML part could not be parsed: ${failure.textContent}`)
  return doc
}

/**
 * Serialize a parsed part back to XML source.
 * @param doc - the parsed XML document to serialize.
 * @returns the serialized XML source.
 */
export function serializeXml(doc: XMLDocument): string {
  return new XMLSerializer().serializeToString(doc)
}

/**
 * Every descendant element with the given local name, in document order.
 * @param root - the node to search.
 * @param localName - the element name without its prefix.
 * @returns the matching elements.
 */
export function elementsNamed(root: Document | Element, localName: string): Element[] {
  const found: Element[] = []
  const walk = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      if (child.localName === localName) found.push(child)
      walk(child)
    }
  }
  const rootElement = root instanceof Document ? root.documentElement : root
  if (rootElement.localName === localName) found.push(rootElement)
  walk(rootElement)
  return found
}

/**
 * Concatenate the text of every descendant leaf named `localName`.
 * @param element - the container to search.
 * @param localName - the leaf element name without its prefix.
 * @returns the concatenated leaf text.
 */
export function textOf(element: Element, localName: string): string {
  return elementsNamed(element, localName).map(node => node.textContent).join('')
}

/**
 * Replace an element's text without touching its identity, so its formatting
 * survives. The first leaf keeps the whole value and later leaves are emptied,
 * because the edited line is one string and the runs that spelled the old one
 * no longer describe it.
 * @param element - the container whose leaves hold the text.
 * @param localName - the leaf element name without its prefix.
 * @param text - the replacement text.
 */
export function setTextOf(element: Element, localName: string, text: string): void {
  const leaves = elementsNamed(element, localName)
  leaves.forEach((leaf, index) => {
    leaf.textContent = index === 0 ? text : ''
    // Leading and trailing spaces are otherwise dropped by a consumer that
    // follows XML's default attribute-value normalization.
    if (index === 0) leaf.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
  })
}
