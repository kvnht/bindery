// Bindery
import Book from './Book';
import Page from '../Page';

// paginate
import shouldIgnoreOverflow from './shouldIgnoreOverflow';
import { addTextNodeIncremental, addTextNode } from './addTextNode';
import RuleSet from './RuleSet';
import orderPages from './orderPages';
import annotatePages from './annotatePages';
import breadcrumbClone from './breadcrumbClone';
import ensureImageLoaded from './ensureImageLoaded';

// Utils
import elToStr from '../utils/elementToString';
import { c, last } from '../utils';

const MAXIMUM_PAGE_LIMIT = 2000;

const isTextNode = node => node.nodeType === Node.TEXT_NODE;
const isElement = node => node.nodeType === Node.ELEMENT_NODE;
const isScript = node => node.tagName === 'SCRIPT';
const isImage = node => node.tagName === 'IMG';
const isUnloadedImage = node => isImage(node) && !node.naturalWidth;
const isContent = node => isElement(node) && !isScript(node);

const sec = ms => (ms / 1000).toFixed(2);

// Walk up the tree to see if we can safely
// insert a split into this node.
const isSplittable = (element, selectorsNotToSplit) => {
  if (selectorsNotToSplit.some(sel => element.matches(sel))) {
    if (element.hasAttribute('data-bindery-did-move')
      || element.classList.contains(c('continuation'))) {
      return true; // ignore rules and split it anyways.
    }
    return false;
  }
  if (element.parentElement) {
    return isSplittable(element.parentElement, selectorsNotToSplit);
  }
  return true;
};

const paginate = (content, rules, progressCallback) => {
  // SETUP
  let layoutWaitingTime = 0;
  let elementCount = 0;
  let elementsProcessed = 0;

  const ruleSet = new RuleSet(rules);

  let breadcrumb = []; // Keep track of position in original tree
  const book = new Book();

  const canSplit = () => !shouldIgnoreOverflow(last(breadcrumb));

  const makeNewPage = () => {
    const newPage = new Page();
    ruleSet.startPage(newPage, book);
    return newPage;
  };

  const finishPage = (page, ignoreOverflow) => {
    if (page && page.hasOverflowed()) {
      console.warn(`Bindery: Page ~${book.pageCount} is overflowing`, book.pageInProgress.element);
      if (!page.suppressErrors && !ignoreOverflow) {
        throw Error('Bindery: Moved to new page when last one is still overflowing');
      }
    }

    // finished with this page, can display
    book.pages = orderPages(book.pages, makeNewPage);
    annotatePages(book.pages);
    if (page) ruleSet.finishPage(page, book);
  };

  // Creates clones for ever level of tag
  // we were in when we overflowed the last page
  const continueOnNewPage = (ignoreOverflow = false) => {
    if (book.pages.length > MAXIMUM_PAGE_LIMIT) {
      throw Error('Bindery: Maximum page count exceeded. Suspected runaway layout.');
    }

    finishPage(book.pageInProgress, ignoreOverflow);

    breadcrumb = breadcrumbClone(breadcrumb, rules);
    const newPage = makeNewPage();

    book.pageInProgress = newPage;
    progressCallback(book);

    book.pages.push(newPage);

    if (breadcrumb[0]) {
      newPage.flowContent.appendChild(breadcrumb[0]);
    }

    // make sure the cloned page is valid.
    if (newPage.hasOverflowed()) {
      const suspect = last(breadcrumb);
      if (suspect) {
        console.warn(`Bindery: Content overflows, probably due to a style set on ${elToStr(suspect)}.`);
        suspect.parentNode.removeChild(suspect);
      } else {
        console.warn('Bindery: Content overflows.');
      }
    }

    return newPage;
  };

  // Shifts this element to the next page. If any of its
  // ancestors cannot be split across page, it will
  // step up the tree to find the first ancestor
  // that can be split, and move all of that descendants
  // to the next page.
  const moveElementToNextPage = (nodeToMove) => {
    // So this node won't get cloned. TODO: this is unclear
    breadcrumb.pop();

    if (breadcrumb.length < 1) {
      throw Error('Bindery: Attempting to move the top-level element');
    }

    // find the nearest splittable parent
    let willMove = nodeToMove;
    const pathToRestore = [];
    while (breadcrumb.length > 1 && !isSplittable(last(breadcrumb), ruleSet.selectorsNotToSplit)) {
      // console.log('Not OK to split:', last(breadcrumb));
      willMove = breadcrumb.pop();
      pathToRestore.unshift(willMove);
    }

    // Once a node is moved to a new page, it should no longer trigger another
    // move. otherwise tall elements will endlessly get shifted to the next page
    willMove.setAttribute('data-bindery-did-move', true);

    const parent = willMove.parentNode;
    parent.removeChild(willMove);

    if (breadcrumb.length > 1 && last(breadcrumb).textContent.trim() === '') {
      parent.appendChild(willMove);
      willMove = breadcrumb.pop();
      pathToRestore.unshift(willMove);
      willMove.parentNode.removeChild(willMove);
    }

    // If the page is empty when this node is removed,
    // then it won't help to move it to the next page.
    // Instead continue here until the node is done.
    if (!book.pageInProgress.isEmpty) {
      if (book.pageInProgress.hasOverflowed()) {
        book.pageInProgress.suppressErrors = true;
      }
      continueOnNewPage();
    }

    // append node as first in new page
    last(breadcrumb).appendChild(willMove);

    // restore subpath
    pathToRestore.forEach((restore) => { breadcrumb.push(restore); });

    breadcrumb.push(nodeToMove);
  };

  const addTextWithoutChecks = (child, parent) => {
    parent.appendChild(child);
    if (canSplit()) {
      book.pageInProgress.suppressErrors = true;
      continueOnNewPage();
    }
  };

  const addSplittableText = async (text) => {
    const result = await addTextNodeIncremental(text, last(breadcrumb), book.pageInProgress);
    if (isTextNode(result)) {
      continueOnNewPage();
      return addSplittableText(result);
    }
    return result;
  };

  const canSplitParent = parent =>
    isSplittable(parent, ruleSet.selectorsNotToSplit)
    && !shouldIgnoreOverflow(parent);

  const addTextChild = async (textNode, parent) => {
    let hasAdded = false;
    if (canSplitParent(parent)) {
      hasAdded = await addSplittableText(textNode);
      if (!hasAdded && breadcrumb.length > 1) {
        // try on next page
        moveElementToNextPage(parent);
        hasAdded = await addSplittableText(textNode);
      }
    } else {
      hasAdded = await addTextNode(textNode, last(breadcrumb), book.pageInProgress);
      if (!hasAdded && canSplit()) {
        moveElementToNextPage(parent);
        hasAdded = await addTextNode(textNode, last(breadcrumb), book.pageInProgress);
      }
    }
    if (!hasAdded) {
      addTextWithoutChecks(textNode, last(breadcrumb));
    }
  };

  // Adds an element node by clearing its childNodes, then inserting them
  // one by one recursively until thet overflow the page
  const addElementNode = async (elementToAdd) => {
    if (book.pageInProgress.hasOverflowed() && canSplit()) {
      book.pageInProgress.suppressErrors = true;
      continueOnNewPage();
    }
    const element = ruleSet.beforeAddElement(elementToAdd, book, continueOnNewPage, makeNewPage);

    if (!breadcrumb[0]) book.pageInProgress.flowContent.appendChild(element);
    else last(breadcrumb).appendChild(element);

    breadcrumb.push(element);

    const childNodes = [...element.childNodes];
    element.innerHTML = '';

    // Overflows when empty
    if (book.pageInProgress.hasOverflowed() && canSplit()) {
      moveElementToNextPage(element);
    }

    for (let i = 0; i < childNodes.length; i += 1) {
      const child = childNodes[i];
      if (isTextNode(child)) {
        await addTextChild(child, element);
      } else if (isUnloadedImage(child)) {
        const waitTime = await ensureImageLoaded(child);
        layoutWaitingTime += waitTime;
        await addElementNode(child);
      } else if (isContent(child)) {
        await addElementNode(child);
      } else {
        // Skip comments and unknown nodes
      }
    }

    const addedChild = breadcrumb.pop();
    ruleSet.afterAddElement(
      addedChild,
      book,
      continueOnNewPage,
      makeNewPage,
      (el) => {
        el.parentNode.removeChild(el);
        continueOnNewPage();
        last(breadcrumb).appendChild(el);
      }
    );
    elementsProcessed += 1;
    book.estimatedProgress = elementsProcessed / elementCount;
  };


  const init = async () => {
    const startLayoutTime = window.performance.now();

    ruleSet.setup();
    content.style.margin = 0;
    content.style.padding = 0;
    elementCount = content.querySelectorAll('*').length;
    continueOnNewPage();

    await addElementNode(content);

    book.pages = orderPages(book.pages, makeNewPage);
    annotatePages(book.pages);

    book.setCompleted();
    ruleSet.finishEveryPage(book);

    const endLayoutTime = window.performance.now();
    const totalTime = endLayoutTime - startLayoutTime;
    const layoutTime = totalTime - layoutWaitingTime;

    console.log(`📖 Book ready in ${sec(totalTime)}s (Layout: ${sec(layoutTime)}s, Waiting for images: ${sec(layoutWaitingTime)}s)`);

    return book;
  };

  return init();
};


export default paginate;
