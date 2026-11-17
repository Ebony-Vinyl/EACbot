package com.eacbot.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SseParserTest {

    @Test
    fun `a whole frame in one chunk parses`() {
        val parser = SseParser()
        val frames = parser.feed("id: 7\nevent: mission.updated\ndata: {\"kind\":\"mission.updated\"}\n\n")
        assertEquals(1, frames.size)
        assertEquals("7", frames.single().id)
        assertEquals("mission.updated", frames.single().event)
        assertEquals("""{"kind":"mission.updated"}""", frames.single().data)
    }

    @Test
    fun `a frame split across chunks still parses exactly once`() {
        val parser = SseParser()
        assertTrue(parser.feed("id: 7\nevent: mission.upd").isEmpty())
        assertTrue(parser.feed("ated\ndata: {\"kind\":").isEmpty())
        val frames = parser.feed("\"mission.updated\"}\n\n")
        assertEquals(1, frames.size)
        assertEquals("7", frames.single().id)
    }

    @Test
    fun `several frames in one chunk all parse`() {
        val parser = SseParser()
        val frames = parser.feed(
            "id: 1\ndata: {\"a\":1}\n\nid: 2\ndata: {\"a\":2}\n\n: keepalive\n\nid: 3\ndata: {\"a\":3}\n\n",
        )
        assertEquals(listOf("1", "2", "3"), frames.map { it.id })
    }

    @Test
    fun `a keepalive comment is not a frame`() {
        val parser = SseParser()
        assertTrue(parser.feed(": keepalive\n\n").isEmpty())
    }

    @Test
    fun `carriage return line endings parse`() {
        val parser = SseParser()
        val frames = parser.feed("id: 4\r\ndata: {}\r\n\r\n")
        assertEquals(1, frames.size)
        assertEquals("4", frames.single().id)
    }

    @Test
    fun `a lone carriage return is normalised`() {
        val parser = SseParser()
        val frames = parser.feed("id: 5\rdata: {}\r\r")
        assertEquals(1, frames.size)
        assertEquals("5", frames.single().id)
    }

    @Test
    fun `multi line data is joined with newlines`() {
        val parser = SseParser()
        val frames = parser.feed("id: 1\ndata: line one\ndata: line two\n\n")
        assertEquals("line one\nline two", frames.single().data)
    }

    @Test
    fun `a retry hint is reported and not treated as data`() {
        val parser = SseParser()
        val frames = parser.feed("retry: 3000\nid: 1\ndata: {}\n\n")
        assertEquals(3000, frames.single().retryMs)
    }

    @Test
    fun `an incomplete frame is not delivered`() {
        val parser = SseParser()
        assertTrue(parser.feed("id: 1\ndata: {\"partial\":").isEmpty())
        // A stream that dies mid-frame must not surface half an event.
        val flushed = parser.flush()
        assertNull(flushed)
    }

    @Test
    fun `a complete frame at the end of a dropped stream is delivered by flush`() {
        val parser = SseParser()
        assertTrue(parser.feed("id: 9\ndata: {\"kind\":\"run.updated\"}\n").isEmpty())
        val flushed = parser.flush()
        assertEquals("9", flushed?.id)
        assertEquals("""{"kind":"run.updated"}""", flushed?.data)
    }

    @Test
    fun `a notification keeps the cursor and the mission it names`() {
        val parser = SseParser()
        val frame = parser.feed(
            "id: 12\nevent: mission.updated\ndata: {\"cursor\":12,\"kind\":\"mission.updated\",\"at\":\"2026-11-15T10:00:00Z\",\"missionId\":\"m-1\",\"revision\":4}\n\n",
        ).single()
        val notification = NotificationCodec.parse(frame)!!
        assertEquals(12L, notification.cursor)
        assertEquals("m-1", notification.missionId)
        assertEquals(4, notification.revision)
        assertTrue(!notification.isResync)
    }

    @Test
    fun `a resync notification is recognised and carries its reason`() {
        val parser = SseParser()
        val frame = parser.feed(
            "id: 99\nevent: stream.resync\ndata: {\"kind\":\"stream.resync\",\"cursor\":99,\"reason\":\"cursor_too_old\",\"at\":\"2026-11-15T10:00:00Z\"}\n\n",
        ).single()
        val notification = NotificationCodec.parse(frame)!!
        assertTrue(notification.isResync)
        assertEquals("cursor_too_old", notification.reason)
    }

    @Test
    fun `a frame without a cursor is dropped rather than guessed`() {
        val frame = SseFrame(id = null, event = "mission.updated", data = "{\"kind\":\"mission.updated\"}", retryMs = null)
        assertNull(NotificationCodec.parse(frame))
    }

    @Test
    fun `malformed data is dropped, not thrown`() {
        val frame = SseFrame(id = "1", event = null, data = "{not json", retryMs = null)
        assertNull(NotificationCodec.parse(frame))
    }

    @Test
    fun `a shutdown notification is distinguishable`() {
        val parser = SseParser()
        val frame = parser.feed("id: 5\nevent: server.shutdown\ndata: {\"kind\":\"server.shutdown\",\"reason\":\"bye\"}\n\n").single()
        val notification = NotificationCodec.parse(frame)!!
        assertTrue(notification.isShutdown)
    }

    @Test
    fun `reset forgets a half-read frame`() {
        val parser = SseParser()
        parser.feed("id: 1\ndata: {\"a\":")
        parser.reset()
        val frames = parser.feed("id: 2\ndata: {}\n\n")
        assertEquals("2", frames.single().id)
        assertEquals("{}", frames.single().data)
    }
}
