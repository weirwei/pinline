// Divider title: a plain line, or "── Space name ────" when there are several Spaces.
const name = new URLSearchParams(location.search).get('name');
document.title = name ? `──  ${name}  ${'─'.repeat(50)}` : '─'.repeat(60);
