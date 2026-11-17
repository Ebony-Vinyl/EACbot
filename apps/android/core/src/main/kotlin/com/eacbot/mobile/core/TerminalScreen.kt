package com.eacbot.mobile.core

/**
 * A terminal screen as a grid of styled cells.
 *
 * The renderer is a deliberate subset of a VT100/xterm: enough for a shell, an
 * editor's alternate screen and a full-screen TUI, and honest about what it
 * ignores. It holds no platform types, so the same code runs on the JVM in a
 * test and in the app.
 */
data class TerminalColor(val value: Int) {
    companion object {
        const val DEFAULT = -1

        fun palette(index: Int): TerminalColor = TerminalColor(index)

        fun rgb(r: Int, g: Int, b: Int): TerminalColor =
            TerminalColor(0x01_00_00_00 or ((r and 0xff) shl 16) or ((g and 0xff) shl 8) or (b and 0xff))
    }

    val isDefault: Boolean get() = value == DEFAULT
    val isRgb: Boolean get() = value ushr 24 == 0x01
    val rgbValue: Int get() = value and 0x00ff_ffff
}

data class CellStyle(
    val foreground: TerminalColor = TerminalColor(TerminalColor.DEFAULT),
    val background: TerminalColor = TerminalColor(TerminalColor.DEFAULT),
    val bold: Boolean = false,
    val dim: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val inverse: Boolean = false,
    val strike: Boolean = false,
) {
    companion object {
        val DEFAULT = CellStyle()
    }
}

data class Cell(val char: String = " ", val style: CellStyle = CellStyle.DEFAULT)

data class CursorPosition(val row: Int, val col: Int)

data class ScreenSnapshot(
    val cols: Int,
    val rows: Int,
    val lines: List<List<Cell>>,
    val cursor: CursorPosition,
    val cursorVisible: Boolean,
    val title: String?,
)

/**
 * Feeds bytes to a [TerminalScreen].
 *
 * The decoder is stateful because a UTF-8 sequence and an escape sequence can
 * both straddle a chunk boundary; splitting them would draw replacement
 * characters the program never printed. Bytes are held until a whole character
 * is available, and a half-read escape sequence waits for the rest of itself.
 */
class TerminalDecoder {
    private val pending = java.io.ByteArrayOutputStream()
    private var heldEscape = ""

    fun decode(bytes: ByteArray): String {
        pending.write(bytes)
        val buffer = pending.toByteArray()
        val usable = completeUtf8Length(buffer)
        if (usable == 0) return ""
        val text = String(buffer, 0, usable, Charsets.UTF_8)
        pending.reset()
        if (usable < buffer.size) pending.write(buffer, usable, buffer.size - usable)
        return emit(heldEscape + text, force = false)
    }

    /** Whatever is still decodable, including a trailing incomplete escape.
     * Called once when the stream ends, so the last bytes are not lost. */
    fun flush(): String {
        val buffer = pending.toByteArray()
        pending.reset()
        return emit(heldEscape + String(buffer, Charsets.UTF_8), force = true)
    }

    private fun emit(text: String, force: Boolean): String {
        if (force) {
            heldEscape = ""
            return text
        }
        val cut = incompleteEscapeStart(text)
        heldEscape = text.substring(cut)
        return text.substring(0, cut)
    }

    /** How many leading bytes form whole UTF-8 characters. */
    private fun completeUtf8Length(buffer: ByteArray): Int {
        if (buffer.isEmpty()) return 0
        var index = buffer.size - 1
        var continuations = 0
        while (index >= 0 && (buffer[index].toInt() and 0xC0) == 0x80) {
            index -= 1
            continuations += 1
        }
        if (index < 0) return 0
        val lead = buffer[index].toInt() and 0xFF
        val needed = when {
            lead and 0x80 == 0 -> 1
            lead and 0xE0 == 0xC0 -> 2
            lead and 0xF0 == 0xE0 -> 3
            lead and 0xF8 == 0xF0 -> 4
            // An invalid lead byte is not something to wait for.
            else -> return buffer.size
        }
        return if (continuations + 1 < needed) index else buffer.size
    }

    private fun incompleteEscapeStart(text: String): Int {
        val esc = text.lastIndexOf('\u001b')
        if (esc < 0) return text.length
        val rest = text.substring(esc)
        if (rest.length == 1) return esc
        return when (rest[1]) {
            '[' -> if (rest.length < 3 || rest.last() !in '@'..'~') esc else text.length
            ']' -> if (!rest.contains('\u0007') && !rest.contains("\u001b\\")) esc else text.length
            '(', ')', '*', '+' -> if (rest.length < 3) esc else text.length
            else -> text.length
        }
    }
}

/** The screen itself: a scrollback-free grid plus the alternate screen.
 *
 * Scrollback is deliberately not modelled. A phone reads the last screenful and
 * the terminal's own scrollback stays where it is; pretending to keep history
 * would grow without bound and disagree with the core's own buffer.
 */
class TerminalScreen(
    var cols: Int = 80,
    var rows: Int = 24,
    private val maxScrollback: Int = 1_000,
) {
    private var primary: Grid = Grid(cols, rows)
    private var alternate: Grid? = null
    private var usingAlternate = false
    private var style = CellStyle.DEFAULT
    private var title: String? = null
    private var cursorVisible = true
    private val scrollback = ArrayDeque<List<Cell>>()
    private var pendingWrap = false
    private var savedCursor: CursorPosition? = null

    private val grid: Grid get() = if (usingAlternate) alternate ?: Grid(cols, rows).also { alternate = it } else primary

    /** A repaint boundary: the next bytes start a fresh screen. */
    fun reset(width: Int = cols, height: Int = rows) {
        cols = width
        rows = height
        primary = Grid(cols, rows)
        alternate = null
        usingAlternate = false
        style = CellStyle.DEFAULT
        pendingWrap = false
        scrollback.clear()
    }

    fun resize(width: Int, height: Int) {
        if (width == cols && height == rows) return
        val nextPrimary = primary.resized(width, height)
        val nextAlternate = alternate?.resized(width, height)
        cols = width
        rows = height
        primary = nextPrimary
        alternate = nextAlternate
    }

    fun write(text: String) {
        var index = 0
        while (index < text.length) {
            val char = text[index]
            when {
                char == '\u001b' -> {
                    val consumed = escape(text, index)
                    if (consumed <= index) return
                    index = consumed
                }
                char == '\n' -> {
                    lineFeed()
                    index += 1
                }
                char == '\r' -> {
                    grid.cursorCol = 0
                    pendingWrap = false
                    index += 1
                }
                char == '\b' -> {
                    grid.cursorCol = (grid.cursorCol - 1).coerceAtLeast(0)
                    pendingWrap = false
                    index += 1
                }
                char == '\t' -> {
                    val next = ((grid.cursorCol / 8) + 1) * 8
                    grid.cursorCol = next.coerceAtMost(cols - 1)
                    pendingWrap = false
                    index += 1
                }
                char == '\u0007' -> index += 1
                char < ' ' -> index += 1
                else -> {
                    index = printable(text, index)
                }
            }
        }
    }

    fun snapshot(): ScreenSnapshot {
        val lines = if (usingAlternate) {
            grid.lines()
        } else {
            scrollback.toList() + grid.lines()
        }
        return ScreenSnapshot(
            cols = cols,
            rows = rows,
            lines = lines,
            cursor = CursorPosition(grid.cursorRow, grid.cursorCol),
            cursorVisible = cursorVisible,
            title = title,
        )
    }

    /** The last `rows` lines, which is what a phone shows without scrolling. */
    fun visible(): List<List<Cell>> = grid.lines()

    fun scrollbackLines(): Int = scrollback.size

    private fun printable(text: String, start: Int): Int {
        val codePoint = text.codePointAt(start)
        val charCount = Character.charCount(codePoint)
        val cellChar = String(Character.toChars(codePoint))
        if (pendingWrap) {
            grid.cursorCol = 0
            lineFeed()
            pendingWrap = false
        }
        grid.set(grid.cursorRow, grid.cursorCol, Cell(cellChar, style))
        if (grid.cursorCol >= cols - 1) {
            pendingWrap = true
        } else {
            grid.cursorCol += 1
        }
        return start + charCount
    }

    private fun lineFeed() {
        if (grid.cursorRow >= rows - 1) {
            val scrolled = grid.scrollUp()
            if (!usingAlternate && scrolled != null) {
                scrollback.addLast(scrolled)
                while (scrollback.size > maxScrollback) scrollback.removeFirst()
            }
        } else {
            grid.cursorRow += 1
        }
        pendingWrap = false
    }

    /** Parses one escape sequence starting at `start`; returns the index after
     * it, or `start` when it is incomplete and must wait for more bytes. */
    private fun escape(text: String, start: Int): Int {
        if (start + 1 >= text.length) return start
        return when (text[start + 1]) {
            '[' -> csi(text, start)
            ']' -> osc(text, start)
            '7' -> {
                savedCursor = CursorPosition(grid.cursorRow, grid.cursorCol)
                start + 2
            }
            '8' -> {
                savedCursor?.let {
                    grid.cursorRow = it.row.coerceIn(0, rows - 1)
                    grid.cursorCol = it.col.coerceIn(0, cols - 1)
                }
                start + 2
            }
            'c' -> {
                reset(cols, rows)
                start + 2
            }
            '(', ')', '*', '+' -> if (start + 2 < text.length) start + 3 else start
            'M' -> {
                if (grid.cursorRow == 0) grid.scrollDown() else grid.cursorRow -= 1
                start + 2
            }
            'D' -> {
                lineFeed()
                start + 2
            }
            'E' -> {
                grid.cursorCol = 0
                lineFeed()
                start + 2
            }
            else -> start + 2
        }
    }

    private fun csi(text: String, start: Int): Int {
        var index = start + 2
        while (index < text.length && text[index] !in '@'..'~') index += 1
        if (index >= text.length) return start
        val body = text.substring(start + 2, index)
        val final = text[index]
        applyCsi(body, final)
        return index + 1
    }

    private fun osc(text: String, start: Int): Int {
        val bel = text.indexOf('\u0007', start + 2)
        val st = text.indexOf("\u001b\\", start + 2)
        val end = when {
            bel < 0 && st < 0 -> return start
            bel < 0 -> st
            st < 0 -> bel
            else -> minOf(bel, st)
        }
        val body = text.substring(start + 2, end)
        val terminator = if (text.startsWith("\u001b\\", end)) end + 2 else end + 1
        when {
            body.startsWith("0;") || body.startsWith("2;") -> title = body.substringAfter(';').ifEmpty { null }
        }
        return terminator
    }

    private fun applyCsi(body: String, final: Char) {
        val private = body.startsWith("?")
        val params = body.removePrefix("?").removePrefix(">").removePrefix("!")
        val numbers = params.split(';').map { it.toIntOrNull() ?: 0 }
        fun param(index: Int, fallback: Int): Int = numbers.getOrNull(index)?.takeIf { it > 0 } ?: fallback

        when (final) {
            'A' -> grid.cursorRow = (grid.cursorRow - param(0, 1)).coerceAtLeast(0)
            'B' -> grid.cursorRow = (grid.cursorRow + param(0, 1)).coerceAtMost(rows - 1)
            'C' -> grid.cursorCol = (grid.cursorCol + param(0, 1)).coerceAtMost(cols - 1)
            'D' -> grid.cursorCol = (grid.cursorCol - param(0, 1)).coerceAtLeast(0)
            'E' -> {
                grid.cursorRow = (grid.cursorRow + param(0, 1)).coerceAtMost(rows - 1)
                grid.cursorCol = 0
            }
            'F' -> {
                grid.cursorRow = (grid.cursorRow - param(0, 1)).coerceAtLeast(0)
                grid.cursorCol = 0
            }
            'G', '`' -> grid.cursorCol = (param(0, 1) - 1).coerceIn(0, cols - 1)
            'd' -> grid.cursorRow = (param(0, 1) - 1).coerceIn(0, rows - 1)
            'H', 'f' -> {
                grid.cursorRow = (param(0, 1) - 1).coerceIn(0, rows - 1)
                grid.cursorCol = (param(1, 1) - 1).coerceIn(0, cols - 1)
            }
            'J' -> eraseInDisplay(numbers.firstOrNull() ?: 0)
            'K' -> eraseInLine(numbers.firstOrNull() ?: 0)
            'm' -> applySgr(numbers)
            'h' -> if (private) setPrivateMode(numbers, true)
            'l' -> if (private) setPrivateMode(numbers, false)
            'L' -> repeat(param(0, 1)) { grid.insertLine() }
            'M' -> repeat(param(0, 1)) { grid.deleteLine() }
            'P' -> repeat(param(0, 1)) { grid.deleteChars() }
            '@' -> repeat(param(0, 1)) { grid.insertChars() }
            'X' -> repeat(param(0, 1)) { grid.eraseChars() }
            'S' -> repeat(param(0, 1)) { grid.scrollUp() }
            'T' -> repeat(param(0, 1)) { grid.scrollDown() }
            'r' -> Unit
            else -> Unit
        }
        pendingWrap = false
    }

    private fun setPrivateMode(numbers: List<Int>, on: Boolean) {
        for (number in numbers) {
            when (number) {
                25 -> cursorVisible = on
                47, 1047, 1049 -> {
                    if (on && !usingAlternate) {
                        alternate = Grid(cols, rows)
                        usingAlternate = true
                    } else if (!on && usingAlternate) {
                        usingAlternate = false
                        alternate = null
                    }
                }
            }
        }
    }

    private fun eraseInDisplay(mode: Int) {
        when (mode) {
            0 -> {
                grid.eraseToEndOfLine(grid.cursorRow, grid.cursorCol)
                for (row in grid.cursorRow + 1 until rows) grid.clearRow(row)
            }
            1 -> {
                for (row in 0 until grid.cursorRow) grid.clearRow(row)
                grid.eraseToStartOfLine(grid.cursorRow, grid.cursorCol)
            }
            else -> {
                for (row in 0 until rows) grid.clearRow(row)
                pendingWrap = false
            }
        }
    }

    private fun eraseInLine(mode: Int) {
        when (mode) {
            0 -> grid.eraseToEndOfLine(grid.cursorRow, grid.cursorCol)
            1 -> grid.eraseToStartOfLine(grid.cursorRow, grid.cursorCol)
            else -> grid.clearRow(grid.cursorRow)
        }
    }

    private fun applySgr(numbers: List<Int>) {
        if (numbers.isEmpty() || numbers == listOf(0)) {
            style = CellStyle.DEFAULT
            return
        }
        var index = 0
        while (index < numbers.size) {
            when (val code = numbers[index]) {
                0 -> style = CellStyle.DEFAULT
                1 -> style = style.copy(bold = true)
                2 -> style = style.copy(dim = true)
                3 -> style = style.copy(italic = true)
                4 -> style = style.copy(underline = true)
                7 -> style = style.copy(inverse = true)
                9 -> style = style.copy(strike = true)
                22 -> style = style.copy(bold = false, dim = false)
                23 -> style = style.copy(italic = false)
                24 -> style = style.copy(underline = false)
                27 -> style = style.copy(inverse = false)
                29 -> style = style.copy(strike = false)
                in 30..37 -> style = style.copy(foreground = TerminalColor.palette(code - 30))
                39 -> style = style.copy(foreground = TerminalColor(TerminalColor.DEFAULT))
                in 40..47 -> style = style.copy(background = TerminalColor.palette(code - 40))
                49 -> style = style.copy(background = TerminalColor(TerminalColor.DEFAULT))
                in 90..97 -> style = style.copy(foreground = TerminalColor.palette(code - 90 + 8))
                in 100..107 -> style = style.copy(background = TerminalColor.palette(code - 100 + 8))
                38, 48 -> {
                    val isForeground = code == 38
                    val (color, consumed) = extendedColor(numbers, index)
                    if (color != null) {
                        style = if (isForeground) style.copy(foreground = color) else style.copy(background = color)
                    }
                    index += consumed
                }
            }
            index += 1
        }
    }

    private fun extendedColor(numbers: List<Int>, start: Int): Pair<TerminalColor?, Int> {
        val kind = numbers.getOrNull(start + 1) ?: return null to 0
        return when (kind) {
            5 -> {
                val index = numbers.getOrNull(start + 2) ?: return null to 1
                TerminalColor.palette(index.coerceIn(0, 255)) to 2
            }
            2 -> {
                val r = numbers.getOrNull(start + 2) ?: return null to 1
                val g = numbers.getOrNull(start + 3) ?: return null to 2
                val b = numbers.getOrNull(start + 4) ?: return null to 3
                TerminalColor.rgb(r, g, b) to 4
            }
            else -> null to 1
        }
    }

    private class Grid(val cols: Int, val rows: Int) {
        private val cells = MutableList(rows) { MutableList(cols) { Cell() } }
        var cursorRow = 0
        var cursorCol = 0

        fun set(row: Int, col: Int, cell: Cell) {
            if (row !in 0 until rows || col !in 0 until cols) return
            cells[row][col] = cell
        }

        fun lines(): List<List<Cell>> = cells.map { it.toList() }

        fun clearRow(row: Int) {
            if (row !in 0 until rows) return
            for (col in 0 until cols) cells[row][col] = Cell()
        }

        fun eraseToEndOfLine(row: Int, col: Int) {
            for (index in col.coerceAtLeast(0) until cols) cells[row][index] = Cell()
        }

        fun eraseToStartOfLine(row: Int, col: Int) {
            for (index in 0..col.coerceAtMost(cols - 1)) cells[row][index] = Cell()
        }

        fun eraseChars() {
            for (index in cursorCol until minOf(cursorCol + 1, cols)) cells[cursorRow][index] = Cell()
        }

        fun insertChars() {
            val row = cells[cursorRow]
            row.add(cursorCol, Cell())
            row.removeAt(cols)
        }

        fun deleteChars() {
            val row = cells[cursorRow]
            row.removeAt(cursorCol)
            row.add(Cell())
        }

        fun insertLine() {
            cells.add(cursorRow, MutableList(cols) { Cell() })
            cells.removeAt(rows)
        }

        fun deleteLine() {
            cells.removeAt(cursorRow)
            cells.add(MutableList(cols) { Cell() })
        }

        /** Scrolls up by one; returns the line that left the top. */
        fun scrollUp(): List<Cell>? {
            val removed = cells.removeAt(0)
            cells.add(MutableList(cols) { Cell() })
            return removed.toList()
        }

        fun scrollDown() {
            cells.add(0, MutableList(cols) { Cell() })
            cells.removeAt(rows)
        }

        fun resized(width: Int, height: Int): Grid {
            val next = Grid(width, height)
            for (row in 0 until minOf(height, rows)) {
                for (col in 0 until minOf(width, cols)) {
                    next.cells[row][col] = cells[row][col]
                }
            }
            next.cursorRow = cursorRow.coerceIn(0, height - 1)
            next.cursorCol = cursorCol.coerceIn(0, width - 1)
            return next
        }
    }
}
