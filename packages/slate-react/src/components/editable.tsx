import React, { useEffect, useRef, useMemo, useCallback, useState } from 'react'
import {
  Editor,
  Element,
  NodeEntry,
  Node,
  Range,
  Text,
  Transforms,
  Path,
  RangeRef,
} from 'slate'
import getDirection from 'direction'
import debounce from 'lodash/debounce'
import throttle from 'lodash/throttle'
import scrollIntoView from 'scroll-into-view-if-needed'

import useChildren from '../hooks/use-children'
import Hotkeys from '../utils/hotkeys'
import {
  HAS_BEFORE_INPUT_SUPPORT,
  IS_IOS,
  IS_CHROME,
  IS_FIREFOX,
  IS_FIREFOX_LEGACY,
  IS_QQBROWSER,
  IS_SAFARI,
  IS_UC_MOBILE,
  IS_WECHATBROWSER,
  CAN_USE_DOM,
} from '../utils/environment'
import { ReactEditor } from '..'
import { ReadOnlyContext } from '../hooks/use-read-only'
import { useSlate } from '../hooks/use-slate'
import { useIsomorphicLayoutEffect } from '../hooks/use-isomorphic-layout-effect'
import { DecorateContext } from '../hooks/use-decorate'
import {
  DOMElement,
  DOMNode,
  DOMRange,
  getDefaultView,
  isDOMElement,
  isDOMNode,
  isPlainTextOnlyPaste,
  DOMText,
} from '../utils/dom'

import {
  EDITOR_TO_ELEMENT,
  ELEMENT_TO_NODE,
  IS_READ_ONLY,
  NODE_TO_ELEMENT,
  IS_FOCUSED,
  PLACEHOLDER_SYMBOL,
  EDITOR_TO_WINDOW,
  EDITOR_TO_USER_SELECTION,
} from '../utils/weak-maps'
import { TRIPLE_CLICK } from '../utils/constants'

type DeferredOperation = () => void

const Children = (props: Parameters<typeof useChildren>[0]) => (
  <React.Fragment>{useChildren(props)}</React.Fragment>
)

/**
 * `RenderElementProps` are passed to the `renderElement` handler.
 */

export interface RenderElementProps {
  children: any
  element: Element
  attributes: {
    'data-slate-node': 'element'
    'data-slate-inline'?: true
    'data-slate-void'?: true
    dir?: 'rtl'
    ref: any
  }
}

/**
 * `RenderLeafProps` are passed to the `renderLeaf` handler.
 */

export interface RenderLeafProps {
  children: any
  leaf: Text
  text: Text
  attributes: {
    'data-slate-leaf': true
  }
}

/**
 * `EditableProps` are passed to the `<Editable>` component.
 */

export type EditableProps = {
  decorate?: (entry: NodeEntry) => Range[]
  onDOMBeforeInput?: (event: InputEvent) => void
  placeholder?: string
  readOnly?: boolean
  role?: string
  style?: React.CSSProperties
  renderElement?: (props: RenderElementProps) => JSX.Element
  renderLeaf?: (props: RenderLeafProps) => JSX.Element
  renderPlaceholder?: (props: RenderPlaceholderProps) => JSX.Element
  scrollSelectionIntoView?: (editor: ReactEditor, domRange: DOMRange) => void
  as?: React.ElementType
} & React.TextareaHTMLAttributes<HTMLDivElement>

/**
 * Editable.
 */

export const Editable = (props: EditableProps) => {
  const {
    autoFocus,
    decorate = defaultDecorate,
    onDOMBeforeInput: propsOnDOMBeforeInput,
    placeholder,
    readOnly = false,
    renderElement,
    renderLeaf,
    renderPlaceholder = props => <DefaultPlaceholder {...props} />,
    scrollSelectionIntoView = defaultScrollSelectionIntoView,
    style = {},
    as: Component = 'div',
    ...attributes
  } = props
  const editor = useSlate()
  // Rerender editor when composition status changed
  const [isComposing, setIsComposing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const deferredOperations = useRef<DeferredOperation[]>([])

  // Update internal state on each render.
  IS_READ_ONLY.set(editor, readOnly)

  // Keep track of some state for the event handler logic.
  const state = useMemo(
    () => ({
      isComposing: false,
      hasInsertPrefixInCompositon: false,
      isDraggingInternally: false,
      isUpdatingSelection: false,
      latestElement: null as DOMElement | null,
    }),
    []
  )

  // Whenever the editor updates...
  useIsomorphicLayoutEffect(() => {
    // Update element-related weak maps with the DOM element ref.
    let window
    if (ref.current && (window = getDefaultView(ref.current))) {
      EDITOR_TO_WINDOW.set(editor, window)
      EDITOR_TO_ELEMENT.set(editor, ref.current)
      NODE_TO_ELEMENT.set(editor, ref.current)
      ELEMENT_TO_NODE.set(ref.current, editor)
    } else {
      NODE_TO_ELEMENT.delete(editor)
    }

    // Make sure the DOM selection state is in sync.
    const { selection } = editor
    const root = ReactEditor.findDocumentOrShadowRoot(editor)
    const domSelection = root.getSelection()

    if (state.isComposing || !domSelection || !ReactEditor.isFocused(editor)) {
      return
    }

    const hasDomSelection = domSelection.type !== 'None'

    // If the DOM selection is properly unset, we're done.
    if (!selection && !hasDomSelection) {
      return
    }

    // verify that the dom selection is in the editor
    const editorElement = EDITOR_TO_ELEMENT.get(editor)!
    let hasDomSelectionInEditor = false
    if (
      editorElement.contains(domSelection.anchorNode) &&
      editorElement.contains(domSelection.focusNode)
    ) {
      hasDomSelectionInEditor = true
    }

    // If the DOM selection is in the editor and the editor selection is already correct, we're done.
    if (hasDomSelection && hasDomSelectionInEditor && selection) {
      const slateRange = ReactEditor.toSlateRange(editor, domSelection, {
        exactMatch: true,

        // domSelection is not necessarily a valid Slate range
        // (e.g. when clicking on contentEditable:false element)
        suppressThrow: true,
      })
      if (slateRange && Range.equals(slateRange, selection)) {
        return
      }
    }

    // when <Editable/> is being controlled through external value
    // then its children might just change - DOM responds to it on its own
    // but Slate's value is not being updated through any operation
    // and thus it doesn't transform selection on its own
    if (selection && !ReactEditor.hasRange(editor, selection)) {
      editor.selection = ReactEditor.toSlateRange(editor, domSelection, {
        exactMatch: false,
        suppressThrow: false,
      })
      return
    }

    // Otherwise the DOM selection is out of sync, so update it.
    state.isUpdatingSelection = true

    const newDomRange = selection && ReactEditor.toDOMRange(editor, selection)
    if (newDomRange) {
      if (Range.isBackward(selection!)) {
        domSelection.setBaseAndExtent(
          newDomRange.endContainer,
          newDomRange.endOffset,
          newDomRange.startContainer,
          newDomRange.startOffset
        )
      } else {
        domSelection.setBaseAndExtent(
          newDomRange.startContainer,
          newDomRange.startOffset,
          newDomRange.endContainer,
          newDomRange.endOffset
        )
      }
      scrollSelectionIntoView(editor, newDomRange)
    } else {
      domSelection.removeAllRanges()
    }

    setTimeout(() => {
      // COMPAT: In Firefox, it's not enough to create a range, you also need
      // to focus the contenteditable element too. (2016/11/16)
      if (newDomRange && IS_FIREFOX) {
        const el = ReactEditor.toDOMNode(editor, editor)
        el.focus()
      }

      state.isUpdatingSelection = false
    })
  })

  // The autoFocus TextareaHTMLAttribute doesn't do anything on a div, so it
  // needs to be manually focused.
  useEffect(() => {
    if (ref.current && autoFocus) {
      ref.current.focus()
    }
  }, [autoFocus])

  // Listen on the native `selectionchange` event to be able to update any time
  // the selection changes. This is required because React's `onSelect` is leaky
  // and non-standard so it doesn't fire until after a selection has been
  // released. This causes issues in situations where another change happens
  // while a selection is being dragged.
  const onDOMSelectionChange = useCallback(
    throttle(() => {
      if (
        !state.isComposing &&
        !state.isUpdatingSelection &&
        !state.isDraggingInternally
      ) {
        const root = ReactEditor.findDocumentOrShadowRoot(editor)
        const { activeElement } = root
        const el = ReactEditor.toDOMNode(editor, editor)
        const domSelection = root.getSelection()

        if (activeElement === el) {
          state.latestElement = activeElement
          IS_FOCUSED.set(editor, true)
        } else {
          IS_FOCUSED.delete(editor)
        }

        if (!domSelection) {
          return Transforms.deselect(editor)
        }

        const { anchorNode, focusNode } = domSelection

        const anchorNodeSelectable =
          hasEditableTarget(editor, anchorNode) ||
          isTargetInsideNonReadonlyVoid(editor, anchorNode)

        const focusNodeSelectable =
          hasEditableTarget(editor, focusNode) ||
          isTargetInsideNonReadonlyVoid(editor, focusNode)

        if (anchorNodeSelectable && focusNodeSelectable) {
          const range = ReactEditor.toSlateRange(editor, domSelection, {
            exactMatch: false,
            suppressThrow: false,
          })
          Transforms.select(editor, range)
        }
      }
    }, 100),
    [readOnly]
  )

  const scheduleOnDOMSelectionChange = useMemo(
    () => debounce(onDOMSelectionChange, 0),
    [onDOMSelectionChange]
  )

  // Listen on the native `beforeinput` event to get real "Level 2" events. This
  // is required because React's `beforeinput` is fake and never really attaches
  // to the real event sadly. (2019/11/01)
  // https://github.com/facebook/react/issues/11211
  const onDOMBeforeInput = useCallback(
    (event: InputEvent) => {
      if (
        !readOnly &&
        hasEditableTarget(editor, event.target) &&
        !isDOMEventHandled(event, propsOnDOMBeforeInput)
      ) {
        // Some IMEs/Chrome extensions like e.g. Grammarly set the selection immediately before
        // triggering a `beforeinput` expecting the change to be applied to the immediately before
        // set selection.
        scheduleOnDOMSelectionChange.flush()
        onDOMSelectionChange.flush()

        const { selection } = editor
        const { inputType: type } = event
        const data = (event as any).dataTransfer || event.data || undefined

        // These two types occur while a user is composing text and can't be
        // cancelled. Let them through and wait for the composition to end.
        if (
          type === 'insertCompositionText' ||
          type === 'deleteCompositionText'
        ) {
          return
        }

        let native = false
        if (
          type === 'insertText' &&
          selection &&
          Range.isCollapsed(selection) &&
          // Only use native character insertion for single characters a-z or space for now.
          // Long-press events (hold a + press 4 = ä) to choose a special character otherwise
          // causes duplicate inserts.
          event.data &&
          event.data.length === 1 &&
          /[a-z ]/i.test(event.data) &&
          // Chrome has issues correctly editing the start of nodes: https://bugs.chromium.org/p/chromium/issues/detail?id=1249405
          // When there is an inline element, e.g. a link, and you select
          // right after it (the start of the next node).
          selection.anchor.offset !== 0
        ) {
          native = true

          // Skip native if there are marks, as
          // `insertText` will insert a node, not just text.
          if (editor.marks) {
            native = false
          }

          // Chrome also has issues correctly editing the end of anchor elements: https://bugs.chromium.org/p/chromium/issues/detail?id=1259100
          // Therefore we don't allow native events to insert text at the end of anchor nodes.
          const { anchor } = selection

          const [node, offset] = ReactEditor.toDOMPoint(editor, anchor)
          const anchorNode = node.parentElement?.closest('a')

          if (anchorNode && ReactEditor.hasDOMNode(editor, anchorNode)) {
            const { document } = ReactEditor.getWindow(editor)

            // Find the last text node inside the anchor.
            const lastText = document
              .createTreeWalker(anchorNode, NodeFilter.SHOW_TEXT)
              .lastChild() as DOMText | null

            if (lastText === node && lastText.textContent?.length === offset) {
              native = false
            }
          }
        }

        // COMPAT: For the deleting forward/backward input types we don't want
        // to change the selection because it is the range that will be deleted,
        // and those commands determine that for themselves.
        if (!type.startsWith('delete') || type.startsWith('deleteBy')) {
          const [targetRange] = (event as any).getTargetRanges()

          if (targetRange) {
            const range = ReactEditor.toSlateRange(editor, targetRange, {
              exactMatch: false,
              suppressThrow: false,
            })

            if (!selection || !Range.equals(selection, range)) {
              native = false

              const selectionRef =
                editor.selection && Editor.rangeRef(editor, editor.selection)

              Transforms.select(editor, range)

              if (selectionRef) {
                EDITOR_TO_USER_SELECTION.set(editor, selectionRef)
              }
            }
          }
        }

        if (!native) {
          event.preventDefault()
        }

        // COMPAT: If the selection is expanded, even if the command seems like
        // a delete forward/backward command it should delete the selection.
        if (
          selection &&
          Range.isExpanded(selection) &&
          type.startsWith('delete')
        ) {
          const direction = type.endsWith('Backward') ? 'backward' : 'forward'
          Editor.deleteFragment(editor, { direction })
          return
        }

        switch (type) {
          case 'deleteByComposition':
          case 'deleteByCut':
          case 'deleteByDrag': {
            Editor.deleteFragment(editor)
            break
          }

          case 'deleteContent':
          case 'deleteContentForward': {
            Editor.deleteForward(editor)
            break
          }

          case 'deleteContentBackward': {
            Editor.deleteBackward(editor)
            break
          }

          case 'deleteEntireSoftLine': {
            Editor.deleteBackward(editor, { unit: 'line' })
            Editor.deleteForward(editor, { unit: 'line' })
            break
          }

          case 'deleteHardLineBackward': {
            Editor.deleteBackward(editor, { unit: 'block' })
            break
          }

          case 'deleteSoftLineBackward': {
            Editor.deleteBackward(editor, { unit: 'line' })
            break
          }

          case 'deleteHardLineForward': {
            Editor.deleteForward(editor, { unit: 'block' })
            break
          }

          case 'deleteSoftLineForward': {
            Editor.deleteForward(editor, { unit: 'line' })
            break
          }

          case 'deleteWordBackward': {
            Editor.deleteBackward(editor, { unit: 'word' })
            break
          }

          case 'deleteWordForward': {
            Editor.deleteForward(editor, { unit: 'word' })
            break
          }

          case 'insertLineBreak':
            Editor.insertSoftBreak(editor)
            break

          case 'insertParagraph': {
            Editor.insertBreak(editor)
            break
          }

          case 'insertFromComposition':
          case 'insertFromDrop':
          case 'insertFromPaste':
          case 'insertFromYank':
          case 'insertReplacementText':
          case 'insertText': {
            const { selection } = editor
            if (selection) {
              if (Range.isExpanded(selection)) {
                Editor.deleteFragment(editor)
              }
            }

            if (type === 'insertFromComposition') {
              // COMPAT: in Safari, `compositionend` is dispatched after the
              // `beforeinput` for "insertFromComposition". But if we wait for it
              // then we will abort because we're still composing and the selection
              // won't be updated properly.
              // https://www.w3.org/TR/input-events-2/
              state.isComposing && setIsComposing(false)
              state.isComposing = false
            }

            // use a weak comparison instead of 'instanceof' to allow
            // programmatic access of paste events coming from external windows
            // like cypress where cy.window does not work realibly
            if (data?.constructor.name === 'DataTransfer') {
              ReactEditor.insertData(editor, data)
            } else if (typeof data === 'string') {
              // Only insertText operations use the native functionality, for now.
              // Potentially expand to single character deletes, as well.
              if (native) {
                deferredOperations.current.push(() =>
                  Editor.insertText(editor, data)
                )
              } else {
                Editor.insertText(editor, data)
              }
            }

            break
          }
        }

        // Restore the actual user section if nothing manually set it.
        const toRestore = EDITOR_TO_USER_SELECTION.get(editor)?.unref()
        EDITOR_TO_USER_SELECTION.delete(editor)

        if (
          toRestore &&
          (!editor.selection || !Range.equals(editor.selection, toRestore))
        ) {
          Transforms.select(editor, toRestore)
        }
      }
    },
    [readOnly, propsOnDOMBeforeInput]
  )

  // Attach a native DOM event handler for `beforeinput` events, because React's
  // built-in `onBeforeInput` is actually a leaky polyfill that doesn't expose
  // real `beforeinput` events sadly... (2019/11/04)
  // https://github.com/facebook/react/issues/11211
  useIsomorphicLayoutEffect(() => {
    if (ref.current && HAS_BEFORE_INPUT_SUPPORT) {
      // @ts-ignore The `beforeinput` event isn't recognized.
      ref.current.addEventListener('beforeinput', onDOMBeforeInput)
    }

    return () => {
      if (ref.current && HAS_BEFORE_INPUT_SUPPORT) {
        // @ts-ignore The `beforeinput` event isn't recognized.
        ref.current.removeEventListener('beforeinput', onDOMBeforeInput)
      }
    }
  }, [onDOMBeforeInput])

  // Attach a native DOM event handler for `selectionchange`, because React's
  // built-in `onSelect` handler doesn't fire for all selection changes. It's a
  // leaky polyfill that only fires on keypresses or clicks. Instead, we want to
  // fire for any change to the selection inside the editor. (2019/11/04)
  // https://github.com/facebook/react/issues/5785
  useIsomorphicLayoutEffect(() => {
    const window = ReactEditor.getWindow(editor)
    window.document.addEventListener(
      'selectionchange',
      scheduleOnDOMSelectionChange
    )

    return () => {
      window.document.removeEventListener(
        'selectionchange',
        scheduleOnDOMSelectionChange
      )
    }
  }, [scheduleOnDOMSelectionChange])

  const decorations = [...Node.nodes(editor)].flatMap(([n, p]) =>
    decorate([n, p])
  )

  if (
    placeholder &&
    editor.children.length === 1 &&
    Array.from(Node.texts(editor)).length === 1 &&
    Node.string(editor) === '' &&
    !isComposing
  ) {
    const start = Editor.start(editor, [])
    decorations.push({
      [PLACEHOLDER_SYMBOL]: true,
      placeholder,
      anchor: start,
      focus: start,
    })
  }

  return (
    <ReadOnlyContext.Provider value={readOnly}>
      <DecorateContext.Provider value={decorate}>
        <Component
          role={readOnly ? undefined : 'textbox'}
          {...attributes}
          // COMPAT: Certain browsers don't support the `beforeinput` event, so we'd
          // have to use hacks to make these replacement-based features work.
          // For SSR situations HAS_BEFORE_INPUT_SUPPORT is false and results in prop
          // mismatch warning app moves to browser. Pass-through consumer props when
          // not CAN_USE_DOM (SSR) and default to falsy value
          spellCheck={
            HAS_BEFORE_INPUT_SUPPORT || !CAN_USE_DOM
              ? attributes.spellCheck
              : false
          }
          autoCorrect={
            HAS_BEFORE_INPUT_SUPPORT || !CAN_USE_DOM
              ? attributes.autoCorrect
              : 'false'
          }
          autoCapitalize={
            HAS_BEFORE_INPUT_SUPPORT || !CAN_USE_DOM
              ? attributes.autoCapitalize
              : 'false'
          }
          data-slate-editor
          data-slate-node="value"
          // explicitly set this
          contentEditable={!readOnly}
          // in some cases, a decoration needs access to the range / selection to decorate a text node,
          // then you will select the whole text node when you select part the of text
          // this magic zIndex="-1" will fix it
          zindex={-1}
          suppressContentEditableWarning
          ref={ref}
          style={{
            // Allow positioning relative to the editable element.
            position: 'relative',
            // Prevent the default outline styles.
            outline: 'none',
            // Preserve adjacent whitespace and new lines.
            whiteSpace: 'pre-wrap',
            // Allow words to break if they are too long.
            wordWrap: 'break-word',
            // Allow for passed-in styles to override anything.
            ...style,
          }}
          onBeforeInput={useCallback(
            (event: React.FormEvent<HTMLDivElement>) => {
              // COMPAT: Certain browsers don't support the `beforeinput` event, so we
              // fall back to React's leaky polyfill instead just for it. It
              // only works for the `insertText` input type.
              if (
                !HAS_BEFORE_INPUT_SUPPORT &&
                !readOnly &&
                !isEventHandled(event, attributes.onBeforeInput) &&
                hasEditableTarget(editor, event.target)
              ) {
                event.preventDefault()
                if (!state.isComposing) {
                  const text = (event as any).data as string
                  Editor.insertText(editor, text)
                }
              }
            },
            [readOnly]
          )}
          onInput={useCallback((event: React.SyntheticEvent) => {
            // Flush native operations, as native events will have propogated
            // and we can correctly compare DOM text values in components
            // to stop rendering, so that browser functions like autocorrect
            // and spellcheck work as expected.
            for (const op of deferredOperations.current) {
              op()
            }
            deferredOperations.current = []
          }, [])}
          onBlur={useCallback(
            (event: React.FocusEvent<HTMLDivElement>) => {
              if (
                readOnly ||
                state.isUpdatingSelection ||
                !hasEditableTarget(editor, event.target) ||
                isEventHandled(event, attributes.onBlur)
              ) {
                return
              }

              // COMPAT: If the current `activeElement` is still the previous
              // one, this is due to the window being blurred when the tab
              // itself becomes unfocused, so we want to abort early to allow to
              // editor to stay focused when the tab becomes focused again.
              const root = ReactEditor.findDocumentOrShadowRoot(editor)
              if (state.latestElement === root.activeElement) {
                return
              }

              const { relatedTarget } = event
              const el = ReactEditor.toDOMNode(editor, editor)

              // COMPAT: The event should be ignored if the focus is returning
              // to the editor from an embedded editable element (eg. an <input>
              // element inside a void node).
              if (relatedTarget === el) {
                return
              }

              // COMPAT: The event should be ignored if the focus is moving from
              // the editor to inside a void node's spacer element.
              if (
                isDOMElement(relatedTarget) &&
                relatedTarget.hasAttribute('data-slate-spacer')
              ) {
                return
              }

              // COMPAT: The event should be ignored if the focus is moving to a
              // non- editable section of an element that isn't a void node (eg.
              // a list item of the check list example).
              if (
                relatedTarget != null &&
                isDOMNode(relatedTarget) &&
                ReactEditor.hasDOMNode(editor, relatedTarget)
              ) {
                const node = ReactEditor.toSlateNode(editor, relatedTarget)

                if (Element.isElement(node) && !editor.isVoid(node)) {
                  return
                }
              }

              // COMPAT: Safari doesn't always remove the selection even if the content-
              // editable element no longer has focus. Refer to:
              // https://stackoverflow.com/questions/12353247/force-contenteditable-div-to-stop-accepting-input-after-it-loses-focus-under-web
              if (IS_SAFARI) {
                const domSelection = root.getSelection()
                domSelection?.removeAllRanges()
              }

              IS_FOCUSED.delete(editor)
            },
            [readOnly, attributes.onBlur]
          )}
          onClick={useCallback(
            (event: React.MouseEvent<HTMLDivElement>) => {
              if (
                hasTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onClick) &&
                isDOMNode(event.target)
              ) {
                const node = ReactEditor.toSlateNode(editor, event.target)
                const path = ReactEditor.findPath(editor, node)

                // At this time, the Slate document may be arbitrarily different,
                // because onClick handlers can change the document before we get here.
                // Therefore we must check that this path actually exists,
                // and that it still refers to the same node.
                if (
                  !Editor.hasPath(editor, path) ||
                  Node.get(editor, path) !== node
                ) {
                  return
                }

                if (event.detail === TRIPLE_CLICK && path.length >= 1) {
                  let blockPath = path
                  if (!Editor.isBlock(editor, node)) {
                    const block = Editor.above(editor, {
                      match: n => Editor.isBlock(editor, n),
                      at: path,
                    })

                    blockPath = block?.[1] ?? path.slice(0, 1)
                  }

                  const range = Editor.range(editor, blockPath)
                  Transforms.select(editor, range)
                  return
                }

                if (readOnly) {
                  return
                }

                const start = Editor.start(editor, path)
                const end = Editor.end(editor, path)
                const startVoid = Editor.void(editor, { at: start })
                const endVoid = Editor.void(editor, { at: end })

                if (
                  startVoid &&
                  endVoid &&
                  Path.equals(startVoid[1], endVoid[1])
                ) {
                  const range = Editor.range(editor, start)
                  Transforms.select(editor, range)
                }
              }
            },
            [readOnly, attributes.onClick]
          )}
          onCompositionEnd={useCallback(
            (event: React.CompositionEvent<HTMLDivElement>) => {
              if (
                hasEditableTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onCompositionEnd)
              ) {
                state.isComposing && setIsComposing(false)
                state.isComposing = false

                // COMPAT: In Chrome, `beforeinput` events for compositions
                // aren't correct and never fire the "insertFromComposition"
                // type that we need. So instead, insert whenever a composition
                // ends since it will already have been committed to the DOM.
                if (
                  !IS_SAFARI &&
                  !IS_FIREFOX_LEGACY &&
                  !IS_IOS &&
                  !IS_QQBROWSER &&
                  !IS_WECHATBROWSER &&
                  !IS_UC_MOBILE &&
                  event.data
                ) {
                  Editor.insertText(editor, event.data)
                } else if (IS_QQBROWSER && IS_CHROME && event.data) {
                  // CHANGED! for chromium core browser, insert whenever a composition
                  // ends since it will already have been committed to the DOM.
                  Editor.insertText(editor, event.data)
                }

                if (editor.selection && Range.isCollapsed(editor.selection)) {
                  const leafPath = editor.selection.anchor.path
                  const currentTextNode = Node.leaf(editor, leafPath)
                  if (state.hasInsertPrefixInCompositon) {
                    state.hasInsertPrefixInCompositon = false
                    Editor.withoutNormalizing(editor, () => {
                      // remove Unicode BOM prefix added in `onCompositionStart`
                      const text = currentTextNode.text.replace(/^\uFEFF/, '')
                      Transforms.delete(editor, {
                        distance: currentTextNode.text.length,
                        reverse: true,
                      })
                      Editor.insertText(editor, text)
                    })
                  }
                }
              }
            },
            [attributes.onCompositionEnd]
          )}
          onCompositionUpdate={useCallback(
            (event: React.CompositionEvent<HTMLDivElement>) => {
              if (
                hasEditableTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onCompositionUpdate)
              ) {
                !state.isComposing && setIsComposing(true)
                state.isComposing = true
              }
            },
            [attributes.onCompositionUpdate]
          )}
          onCompositionStart={useCallback(
            (event: React.CompositionEvent<HTMLDivElement>) => {
              if (
                hasEditableTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onCompositionStart)
              ) {
                const { selection, marks } = editor
                if (selection) {
                  if (Range.isExpanded(selection)) {
                    Editor.deleteFragment(editor)
                    return
                  }
                  // const inline = Editor.above(editor, {
                  //   match: n => Editor.isInline(editor, n),
                  //   mode: 'highest',
                  // })
                  // if (inline) {
                  //   const [, inlinePath] = inline
                  //   if (Editor.isEnd(editor, selection.anchor, inlinePath)) {
                  //     const point = Editor.after(editor, inlinePath)!
                  //     Transforms.setSelection(editor, {
                  //       anchor: point,
                  //       focus: point,
                  //     })
                  //   }
                  // }
                  // insert new node in advance to ensure composition text will insert
                  // along with final input text
                  // add Unicode BOM prefix to avoid normalize removing this node
                  if (marks) {
                    state.hasInsertPrefixInCompositon = true
                    Transforms.insertNodes(
                      editor,
                      {
                        text: '\uFEFF',
                        ...marks,
                      },
                      {
                        select: true,
                      }
                    )
                  }
                }
              }
            },
            [attributes.onCompositionStart]
          )}
          onCopy={useCallback(
            (event: React.ClipboardEvent<HTMLDivElement>) => {
              if (
                hasEditableTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onCopy)
              ) {
                event.preventDefault()
                ReactEditor.setFragmentData(editor, event.clipboardData, 'copy')
              }
            },
            [attributes.onCopy]
          )}
          onCut={useCallback(
            (event: React.ClipboardEvent<HTMLDivElement>) => {
              if (
                !readOnly &&
                hasEditableTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onCut)
              ) {
                event.preventDefault()
                ReactEditor.setFragmentData(editor, event.clipboardData, 'cut')
                const { selection } = editor

                if (selection) {
                  if (Range.isExpanded(selection)) {
                    Editor.deleteFragment(editor)
                  } else {
                    const node = Node.parent(editor, selection.anchor.path)
                    if (Editor.isVoid(editor, node)) {
                      Transforms.delete(editor)
                    }
                  }
                }
              }
            },
            [readOnly, attributes.onCut]
          )}
          onDragOver={useCallback(
            (event: React.DragEvent<HTMLDivElement>) => {
              if (
                hasTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onDragOver)
              ) {
                // Only when the target is void, call `preventDefault` to signal
                // that drops are allowed. Editable content is droppable by
                // default, and calling `preventDefault` hides the cursor.
                const node = ReactEditor.toSlateNode(editor, event.target)

                if (Editor.isVoid(editor, node)) {
                  event.preventDefault()
                }
              }
            },
            [attributes.onDragOver]
          )}
          onDragStart={useCallback(
            (event: React.DragEvent<HTMLDivElement>) => {
              if (
                !readOnly &&
                hasTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onDragStart)
              ) {
                const node = ReactEditor.toSlateNode(editor, event.target)
                const path = ReactEditor.findPath(editor, node)
                const voidMatch =
                  Editor.isVoid(editor, node) ||
                  Editor.void(editor, { at: path, voids: true })

                // If starting a drag on a void node, make sure it is selected
                // so that it shows up in the selection's fragment.
                if (voidMatch) {
                  const range = Editor.range(editor, path)
                  Transforms.select(editor, range)
                }

                state.isDraggingInternally = true

                ReactEditor.setFragmentData(editor, event.dataTransfer, 'drag')
              }
            },
            [readOnly, attributes.onDragStart]
          )}
          onDrop={useCallback(
            (event: React.DragEvent<HTMLDivElement>) => {
              if (
                !readOnly &&
                hasTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onDrop)
              ) {
                event.preventDefault()

                // Keep a reference to the dragged range before updating selection
                const draggedRange = editor.selection

                // Find the range where the drop happened
                const range = ReactEditor.findEventRange(editor, event)
                const data = event.dataTransfer

                Transforms.select(editor, range)

                if (state.isDraggingInternally) {
                  if (
                    draggedRange &&
                    !Range.equals(draggedRange, range) &&
                    !Editor.void(editor, { at: range, voids: true })
                  ) {
                    Transforms.delete(editor, {
                      at: draggedRange,
                    })
                  }
                }

                ReactEditor.insertData(editor, data)

                // When dragging from another source into the editor, it's possible
                // that the current editor does not have focus.
                if (!ReactEditor.isFocused(editor)) {
                  ReactEditor.focus(editor)
                }
              }

              state.isDraggingInternally = false
            },
            [readOnly, attributes.onDrop]
          )}
          onDragEnd={useCallback(
            (event: React.DragEvent<HTMLDivElement>) => {
              if (
                !readOnly &&
                state.isDraggingInternally &&
                attributes.onDragEnd &&
                hasTarget(editor, event.target)
              ) {
                attributes.onDragEnd(event)
              }

              // When dropping on a different droppable element than the current editor,
              // `onDrop` is not called. So we need to clean up in `onDragEnd` instead.
              // Note: `onDragEnd` is only called when `onDrop` is not called
              state.isDraggingInternally = false
            },
            [readOnly, attributes.onDragEnd]
          )}
          onFocus={useCallback(
            (event: React.FocusEvent<HTMLDivElement>) => {
              if (
                !readOnly &&
                !state.isUpdatingSelection &&
                hasEditableTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onFocus)
              ) {
                const el = ReactEditor.toDOMNode(editor, editor)
                const root = ReactEditor.findDocumentOrShadowRoot(editor)
                state.latestElement = root.activeElement

                // COMPAT: If the editor has nested editable elements, the focus
                // can go to them. In Firefox, this must be prevented because it
                // results in issues with keyboard navigation. (2017/03/30)
                if (IS_FIREFOX && event.target !== el) {
                  el.focus()
                  return
                }

                IS_FOCUSED.set(editor, true)
              }
            },
            [readOnly, attributes.onFocus]
          )}
          onKeyDown={useCallback(
            (event: React.KeyboardEvent<HTMLDivElement>) => {
              if (
                !readOnly &&
                hasEditableTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onKeyDown) &&
                !state.isComposing
              ) {
                const { nativeEvent } = event
                const { selection } = editor

                const element =
                  editor.children[
                    selection !== null ? selection.focus.path[0] : 0
                  ]
                const isRTL = getDirection(Node.string(element)) === 'rtl'

                // COMPAT: Since we prevent the default behavior on
                // `beforeinput` events, the browser doesn't think there's ever
                // any history stack to undo or redo, so we have to manage these
                // hotkeys ourselves. (2019/11/06)
                if (Hotkeys.isRedo(nativeEvent)) {
                  event.preventDefault()
                  const maybeHistoryEditor: any = editor

                  if (typeof maybeHistoryEditor.redo === 'function') {
                    maybeHistoryEditor.redo()
                  }

                  return
                }

                if (Hotkeys.isUndo(nativeEvent)) {
                  event.preventDefault()
                  const maybeHistoryEditor: any = editor

                  if (typeof maybeHistoryEditor.undo === 'function') {
                    maybeHistoryEditor.undo()
                  }

                  return
                }

                // COMPAT: Certain browsers don't handle the selection updates
                // properly. In Chrome, the selection isn't properly extended.
                // And in Firefox, the selection isn't properly collapsed.
                // (2017/10/17)
                if (Hotkeys.isMoveLineBackward(nativeEvent)) {
                  event.preventDefault()
                  Transforms.move(editor, { unit: 'line', reverse: true })
                  return
                }

                if (Hotkeys.isMoveLineForward(nativeEvent)) {
                  event.preventDefault()
                  Transforms.move(editor, { unit: 'line' })
                  return
                }

                if (Hotkeys.isExtendLineBackward(nativeEvent)) {
                  event.preventDefault()
                  Transforms.move(editor, {
                    unit: 'line',
                    edge: 'focus',
                    reverse: true,
                  })
                  return
                }

                if (Hotkeys.isExtendLineForward(nativeEvent)) {
                  event.preventDefault()
                  Transforms.move(editor, { unit: 'line', edge: 'focus' })
                  return
                }

                // COMPAT: If a void node is selected, or a zero-width text node
                // adjacent to an inline is selected, we need to handle these
                // hotkeys manually because browsers won't be able to skip over
                // the void node with the zero-width space not being an empty
                // string.
                if (Hotkeys.isMoveBackward(nativeEvent)) {
                  event.preventDefault()

                  if (selection && Range.isCollapsed(selection)) {
                    Transforms.move(editor, { reverse: !isRTL })
                  } else {
                    Transforms.collapse(editor, { edge: 'start' })
                  }

                  return
                }

                if (Hotkeys.isMoveForward(nativeEvent)) {
                  event.preventDefault()

                  if (selection && Range.isCollapsed(selection)) {
                    Transforms.move(editor, { reverse: isRTL })
                  } else {
                    Transforms.collapse(editor, { edge: 'end' })
                  }

                  return
                }

                if (Hotkeys.isMoveWordBackward(nativeEvent)) {
                  event.preventDefault()

                  if (selection && Range.isExpanded(selection)) {
                    Transforms.collapse(editor, { edge: 'focus' })
                  }

                  Transforms.move(editor, { unit: 'word', reverse: !isRTL })
                  return
                }

                if (Hotkeys.isMoveWordForward(nativeEvent)) {
                  event.preventDefault()

                  if (selection && Range.isExpanded(selection)) {
                    Transforms.collapse(editor, { edge: 'focus' })
                  }

                  Transforms.move(editor, { unit: 'word', reverse: isRTL })
                  return
                }

                // COMPAT: Certain browsers don't support the `beforeinput` event, so we
                // fall back to guessing at the input intention for hotkeys.
                // COMPAT: In iOS, some of these hotkeys are handled in the
                if (!HAS_BEFORE_INPUT_SUPPORT) {
                  // We don't have a core behavior for these, but they change the
                  // DOM if we don't prevent them, so we have to.
                  if (
                    Hotkeys.isBold(nativeEvent) ||
                    Hotkeys.isItalic(nativeEvent) ||
                    Hotkeys.isTransposeCharacter(nativeEvent)
                  ) {
                    event.preventDefault()
                    return
                  }

                  if (Hotkeys.isSoftBreak(nativeEvent)) {
                    event.preventDefault()
                    Editor.insertSoftBreak(editor)
                    return
                  }

                  if (Hotkeys.isSplitBlock(nativeEvent)) {
                    event.preventDefault()
                    Editor.insertBreak(editor)
                    return
                  }

                  if (Hotkeys.isDeleteBackward(nativeEvent)) {
                    event.preventDefault()

                    if (selection && Range.isExpanded(selection)) {
                      Editor.deleteFragment(editor, { direction: 'backward' })
                    } else {
                      Editor.deleteBackward(editor)
                    }

                    return
                  }

                  if (Hotkeys.isDeleteForward(nativeEvent)) {
                    event.preventDefault()

                    if (selection && Range.isExpanded(selection)) {
                      Editor.deleteFragment(editor, { direction: 'forward' })
                    } else {
                      Editor.deleteForward(editor)
                    }

                    return
                  }

                  if (Hotkeys.isDeleteLineBackward(nativeEvent)) {
                    event.preventDefault()

                    if (selection && Range.isExpanded(selection)) {
                      Editor.deleteFragment(editor, { direction: 'backward' })
                    } else {
                      Editor.deleteBackward(editor, { unit: 'line' })
                    }

                    return
                  }

                  if (Hotkeys.isDeleteLineForward(nativeEvent)) {
                    event.preventDefault()

                    if (selection && Range.isExpanded(selection)) {
                      Editor.deleteFragment(editor, { direction: 'forward' })
                    } else {
                      Editor.deleteForward(editor, { unit: 'line' })
                    }

                    return
                  }

                  if (Hotkeys.isDeleteWordBackward(nativeEvent)) {
                    event.preventDefault()

                    if (selection && Range.isExpanded(selection)) {
                      Editor.deleteFragment(editor, { direction: 'backward' })
                    } else {
                      Editor.deleteBackward(editor, { unit: 'word' })
                    }

                    return
                  }

                  if (Hotkeys.isDeleteWordForward(nativeEvent)) {
                    event.preventDefault()

                    if (selection && Range.isExpanded(selection)) {
                      Editor.deleteFragment(editor, { direction: 'forward' })
                    } else {
                      Editor.deleteForward(editor, { unit: 'word' })
                    }

                    return
                  }
                } else {
                  if (IS_CHROME || IS_SAFARI) {
                    // COMPAT: Chrome and Safari support `beforeinput` event but do not fire
                    // an event when deleting backwards in a selected void inline node
                    if (
                      selection &&
                      (Hotkeys.isDeleteBackward(nativeEvent) ||
                        Hotkeys.isDeleteForward(nativeEvent)) &&
                      Range.isCollapsed(selection)
                    ) {
                      const currentNode = Node.parent(
                        editor,
                        selection.anchor.path
                      )

                      if (
                        Element.isElement(currentNode) &&
                        Editor.isVoid(editor, currentNode) &&
                        Editor.isInline(editor, currentNode)
                      ) {
                        event.preventDefault()
                        Editor.deleteBackward(editor, { unit: 'block' })

                        return
                      }
                    }
                  }
                }
              }
            },
            [readOnly, attributes.onKeyDown]
          )}
          onPaste={useCallback(
            (event: React.ClipboardEvent<HTMLDivElement>) => {
              if (
                !readOnly &&
                hasEditableTarget(editor, event.target) &&
                !isEventHandled(event, attributes.onPaste)
              ) {
                // COMPAT: Certain browsers don't support the `beforeinput` event, so we
                // fall back to React's `onPaste` here instead.
                // COMPAT: Firefox, Chrome and Safari don't emit `beforeinput` events
                // when "paste without formatting" is used, so fallback. (2020/02/20)
                if (
                  !HAS_BEFORE_INPUT_SUPPORT ||
                  isPlainTextOnlyPaste(event.nativeEvent)
                ) {
                  event.preventDefault()
                  ReactEditor.insertData(editor, event.clipboardData)
                }
              }
            },
            [readOnly, attributes.onPaste]
          )}
        >
          <Children
            decorations={decorations}
            node={editor}
            renderElement={renderElement}
            renderPlaceholder={renderPlaceholder}
            renderLeaf={renderLeaf}
            selection={editor.selection}
          />
        </Component>
      </DecorateContext.Provider>
    </ReadOnlyContext.Provider>
  )
}

/**
 * The props that get passed to renderPlaceholder
 */
export type RenderPlaceholderProps = {
  children: any
  attributes: {
    'data-slate-placeholder': boolean
    dir?: 'rtl'
    contentEditable: boolean
    ref: React.RefObject<any>
    style: React.CSSProperties
  }
}

/**
 * The default placeholder element
 */

export const DefaultPlaceholder = ({
  attributes,
  children,
}: RenderPlaceholderProps) => <span {...attributes}>{children}</span>

/**
 * A default memoized decorate function.
 */

export const defaultDecorate: (entry: NodeEntry) => Range[] = () => []

/**
 * A default implement to scroll dom range into view.
 */

const defaultScrollSelectionIntoView = (
  editor: ReactEditor,
  domRange: DOMRange
) => {
  // This was affecting the selection of multiple blocks and dragging behavior,
  // so enabled only if the selection has been collapsed.
  if (
    !editor.selection ||
    (editor.selection && Range.isCollapsed(editor.selection))
  ) {
    const leafEl = domRange.startContainer.parentElement!
    leafEl.getBoundingClientRect = domRange.getBoundingClientRect.bind(domRange)
    scrollIntoView(leafEl, {
      scrollMode: 'if-needed',
    })
    delete leafEl.getBoundingClientRect
  }
}

/**
 * Check if the target is in the editor.
 */

export const hasTarget = (
  editor: ReactEditor,
  target: EventTarget | null
): target is DOMNode => {
  return isDOMNode(target) && ReactEditor.hasDOMNode(editor, target)
}

/**
 * Check if the target is editable and in the editor.
 */

export const hasEditableTarget = (
  editor: ReactEditor,
  target: EventTarget | null
): target is DOMNode => {
  return (
    isDOMNode(target) &&
    ReactEditor.hasDOMNode(editor, target, { editable: true })
  )
}

/**
 * Check if the target is inside void and in an non-readonly editor.
 */

export const isTargetInsideNonReadonlyVoid = (
  editor: ReactEditor,
  target: EventTarget | null
): boolean => {
  if (IS_READ_ONLY.get(editor)) return false

  const slateNode =
    hasTarget(editor, target) && ReactEditor.toSlateNode(editor, target)
  return Editor.isVoid(editor, slateNode)
}

/**
 * Check if an event is overrided by a handler.
 */

export const isEventHandled = <
  EventType extends React.SyntheticEvent<unknown, unknown>
>(
  event: EventType,
  handler?: (event: EventType) => void | boolean
) => {
  if (!handler) {
    return false
  }
  // The custom event handler may return a boolean to specify whether the event
  // shall be treated as being handled or not.
  const shouldTreatEventAsHandled = handler(event)

  if (shouldTreatEventAsHandled != null) {
    return shouldTreatEventAsHandled
  }

  return event.isDefaultPrevented() || event.isPropagationStopped()
}

/**
 * Check if a DOM event is overrided by a handler.
 */

export const isDOMEventHandled = <E extends Event>(
  event: E,
  handler?: (event: E) => void | boolean
) => {
  if (!handler) {
    return false
  }

  // The custom event handler may return a boolean to specify whether the event
  // shall be treated as being handled or not.
  const shouldTreatEventAsHandled = handler(event)

  if (shouldTreatEventAsHandled != null) {
    return shouldTreatEventAsHandled
  }

  return event.defaultPrevented
}
