package com.eacbot.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.eacbot.mobile.design.LocalEacbotColors

enum class AppSection(val title: String, val detail: String, val icon: ImageVector) {
    Chat("对话", "和电脑上的助手聊天", Icons.Filled.Chat),
    Tasks("任务", "交给智能体执行的工作", Icons.Filled.Assignment),
}

val LocalOpenDrawer = staticCompositionLocalOf<() -> Unit> { {} }

@Composable
fun MenuButton(modifier: Modifier = Modifier) {
    CircleButton(Icons.Filled.Menu, "菜单", LocalOpenDrawer.current, modifier)
}

@Composable
fun AppDrawer(current: AppSection, onSelect: (AppSection) -> Unit) {
    val colors = LocalEacbotColors.current
    Column(
        Modifier
            .fillMaxHeight()
            .width(304.dp)
            .clip(RoundedCornerShape(topEnd = 28.dp, bottomEnd = 28.dp))
            .background(colors.canvas)
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = 14.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            Modifier.padding(horizontal = 8.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            CompanionAvatar(52.dp)
            Column {
                Text("EACbot", style = MaterialTheme.typography.titleLarge, color = colors.ink)
                Text("你的智能体助手", style = MaterialTheme.typography.bodySmall, color = colors.inkMuted)
            }
        }
        Spacer(Modifier.size(8.dp))
        AppSection.entries.forEach { section ->
            DrawerItem(section, section == current) { onSelect(section) }
        }
    }
}

@Composable
private fun DrawerItem(section: AppSection, selected: Boolean, onClick: () -> Unit) {
    val colors = LocalEacbotColors.current
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(if (selected) colors.surface else colors.canvas)
            .clickable(role = Role.Tab, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        IconTile(
            section.icon,
            tint = if (selected) colors.accent else colors.inkMuted,
            background = if (selected) colors.accentSoft else colors.surfaceRaised,
            size = 40.dp,
        )
        Column(Modifier.weight(1f)) {
            Text(
                section.title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                color = colors.ink,
            )
            Text(section.detail, style = MaterialTheme.typography.bodySmall, color = colors.inkMuted)
        }
        if (selected) Box(Modifier.size(8.dp).clip(CircleShape).background(colors.accent))
    }
}
