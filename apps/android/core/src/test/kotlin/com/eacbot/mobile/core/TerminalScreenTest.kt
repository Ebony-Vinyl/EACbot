package com.eacbot.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalScreenTest {

    private fun screen(cols: Int = 20, rows: Int = 4): TerminalScreen = TerminalScreen(cols, rows)

    /** The drawn lines, with trailing blank rows dropped so a test states only
     * what was printed. A bare `\n` is a line feed and keeps the column, as in
     * a real terminal; a program that wants the next line to start at column
     * zero sends `\r\n`, which is what the PTY's ONLCR does. */
    private fun TerminalScreen.text(): String {
        val lines = visible().map { row -> row.joinToString("") { it.char }.trimEnd() }
        return lines.dropLastWhile { it.isEmpty() }.joinToString("\n")
    }

    @Test
    fun `plain text lands in the grid and wraps at the column count`() {
        val screen = screen(cols = 5, rows = 3)
        screen.write("abcdefgh")
        assertEquals("abcde\nfgh", screen.text())
    }

    @Test
    fun `a line feed keeps the column and scrolling keeps the last lines`() {
        val screen = screen(cols = 6, rows = 2)
        screen.write("one\r\ntwo\r\nthree")
        assertEquals("two\nthree", screen.text())
        assertEquals(1, screen.scrollbackLines())
    }

    @Test
    fun `carriage return returns to the first column`() {
        val screen = screen(cols = 10, rows = 2)
        screen.write("abcdef\rXY")
        assertEquals("XYcdef", screen.text())
    }

    @Test
    fun `an erase to end of line clears the rest of the row`() {
        val screen = screen(cols = 10, rows = 2)
        screen.write("abcdef\r\u001b[K")
        assertEquals("", screen.text())
    }

    @Test
    fun `cursor positioning moves to the requested cell`() {
        val screen = screen(cols = 10, rows = 3)
        screen.write("\u001b[2;3HX")
        val lines = screen.visible()
        assertEquals(" ", lines[1][1].char)
        assertEquals("X", lines[1][2].char)
    }

    @Test
    fun `bold and colours are recorded on the cell, not the whole screen`() {
        val screen = screen(cols = 10, rows = 2)
        screen.write("\u001b[1;31mred\u001b[0m plain")
        val row = screen.visible()[0]
        assertEquals("r", row[0].char)
        assertTrue(row[0].style.bold)
        assertEquals(1, row[0].style.foreground.value)
        assertFalse(row[4].style.bold)
        assertTrue(row[4].style.foreground.isDefault)
    }

    @Test
    fun `256 colour and true colour are distinguished`() {
        val screen = screen(cols = 10, rows = 2)
        screen.write("\u001b[38;5;208mx\u001b[38;2;10;20;30my")
        val row = screen.visible()[0]
        assertEquals(208, row[0].style.foreground.value)
        assertTrue(row[1].style.foreground.isRgb)
        assertEquals((10 shl 16) or (20 shl 8) or 30, row[1].style.foreground.rgbValue)
    }

    @Test
    fun `the alternate screen is used and then restored`() {
        val screen = screen(cols = 10, rows = 2)
        screen.write("primary")
        screen.write("\u001b[?1049h")
        screen.write("alternate")
        assertEquals("alternate", screen.text())
        screen.write("\u001b[?1049l")
        assertEquals("primary", screen.text())
    }

    @Test
    fun `an osc title is captured and never drawn`() {
        val screen = screen(cols = 20, rows = 2)
        screen.write("\u001b]0;zsh\u0007hello")
        assertEquals("hello", screen.text())
        assertEquals("zsh", screen.snapshot().title)
    }

    @Test
    fun `a resize keeps the content that still fits`() {
        val screen = screen(cols = 10, rows = 3)
        screen.write("abc\r\ndef")
        screen.resize(5, 3)
        assertEquals("abc\ndef", screen.text())
        assertEquals(5, screen.snapshot().cols)
    }

    @Test
    fun `the cursor is reported where the next character goes`() {
        val screen = screen(cols = 10, rows = 3)
        screen.write("ab")
        val snapshot = screen.snapshot()
        assertEquals(0, snapshot.cursor.row)
        assertEquals(2, snapshot.cursor.col)
    }

    @Test
    fun `cursor visibility follows the private mode`() {
        val screen = screen()
        assertTrue(screen.snapshot().cursorVisible)
        screen.write("\u001b[?25l")
        assertFalse(screen.snapshot().cursorVisible)
        screen.write("\u001b[?25h")
        assertTrue(screen.snapshot().cursorVisible)
    }

    @Test
    fun `scrollback is bounded so a chatty program cannot grow it forever`() {
        val screen = TerminalScreen(cols = 4, rows = 2, maxScrollback = 3)
        repeat(10) { screen.write("line$it\n") }
        assertTrue(screen.scrollbackLines() <= 3)
    }

    @Test
    fun `a reset starts a fresh screen`() {
        val screen = screen(cols = 5, rows = 2)
        screen.write("dirty")
        screen.reset(5, 2)
        assertEquals("", screen.text())
        assertEquals(0, screen.scrollbackLines())
    }

    @Test
    fun `the decoder keeps a split utf-8 character whole`() {
        val decoder = TerminalDecoder()
        val bytes = "héllo".toByteArray(Charsets.UTF_8)
        val first = decoder.decode(bytes.copyOfRange(0, 2))
        val rest = decoder.decode(bytes.copyOfRange(2, bytes.size))
        assertEquals("héllo", first + rest)
    }

    @Test
    fun `the decoder keeps a split escape sequence whole`() {
        val decoder = TerminalDecoder()
        val bytes = "\u001b[31mred".toByteArray(Charsets.UTF_8)
        val first = decoder.decode(bytes.copyOfRange(0, 3))
        val rest = decoder.decode(bytes.copyOfRange(3, bytes.size))
        assertEquals("", first)
        assertEquals("\u001b[31mred", rest)
    }

    @Test
    fun `the decoder flushes an incomplete sequence at the end of a stream`() {
        val decoder = TerminalDecoder()
        assertEquals("ab", decoder.decode("ab\u001b".toByteArray()))
        assertEquals("\u001b", decoder.flush())
    }
}
