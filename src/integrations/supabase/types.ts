export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      analyses: {
        Row: {
          avg_confidence: number | null
          created_at: string
          id: string
          league_id: string | null
          league_name: string | null
          matches_analyzed: number
          notes: string | null
          predictions_generated: number
          scan_date: string
          status: string
        }
        Insert: {
          avg_confidence?: number | null
          created_at?: string
          id?: string
          league_id?: string | null
          league_name?: string | null
          matches_analyzed?: number
          notes?: string | null
          predictions_generated?: number
          scan_date?: string
          status?: string
        }
        Update: {
          avg_confidence?: number | null
          created_at?: string
          id?: string
          league_id?: string | null
          league_name?: string | null
          matches_analyzed?: number
          notes?: string | null
          predictions_generated?: number
          scan_date?: string
          status?: string
        }
        Relationships: []
      }
      analysis_cache: {
        Row: {
          fetched_at: string
          match_id: string
          raw: Json
        }
        Insert: {
          fetched_at?: string
          match_id: string
          raw: Json
        }
        Update: {
          fetched_at?: string
          match_id?: string
          raw?: Json
        }
        Relationships: []
      }
      api_key_status: {
        Row: {
          active: boolean
          api_key: string | null
          exhausted_at: string | null
          key_index: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          api_key?: string | null
          exhausted_at?: string | null
          key_index: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          api_key?: string | null
          exhausted_at?: string | null
          key_index?: number
          updated_at?: string
        }
        Relationships: []
      }
      api_usage: {
        Row: {
          called_at: string
          date: string | null
          endpoint: string
          id: string
        }
        Insert: {
          called_at?: string
          date?: string | null
          endpoint: string
          id?: string
        }
        Update: {
          called_at?: string
          date?: string | null
          endpoint?: string
          id?: string
        }
        Relationships: []
      }
      daily_best_picks: {
        Row: {
          combo_prediction_id_1: string | null
          combo_prediction_id_2: string | null
          day: string
          locked_at: string
          single_prediction_id: string | null
        }
        Insert: {
          combo_prediction_id_1?: string | null
          combo_prediction_id_2?: string | null
          day: string
          locked_at?: string
          single_prediction_id?: string | null
        }
        Update: {
          combo_prediction_id_1?: string | null
          combo_prediction_id_2?: string | null
          day?: string
          locked_at?: string
          single_prediction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_best_picks_combo_prediction_id_1_fkey"
            columns: ["combo_prediction_id_1"]
            isOneToOne: false
            referencedRelation: "predictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_best_picks_combo_prediction_id_2_fkey"
            columns: ["combo_prediction_id_2"]
            isOneToOne: false
            referencedRelation: "predictions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_best_picks_single_prediction_id_fkey"
            columns: ["single_prediction_id"]
            isOneToOne: false
            referencedRelation: "predictions"
            referencedColumns: ["id"]
          },
        ]
      }
      engine_settings: {
        Row: {
          data_engine: string
          id: boolean
          odds_api_key: string | null
          sport_keys: string[] | null
          updated_at: string
        }
        Insert: {
          data_engine?: string
          id?: boolean
          odds_api_key?: string | null
          sport_keys?: string[] | null
          updated_at?: string
        }
        Update: {
          data_engine?: string
          id?: boolean
          odds_api_key?: string | null
          sport_keys?: string[] | null
          updated_at?: string
        }
        Relationships: []
      }
      fixtures_cache: {
        Row: {
          away_team: string | null
          fetched_at: string
          home_team: string | null
          kickoff: string | null
          league_id: string | null
          league_name: string | null
          match_id: string
          raw: Json
        }
        Insert: {
          away_team?: string | null
          fetched_at?: string
          home_team?: string | null
          kickoff?: string | null
          league_id?: string | null
          league_name?: string | null
          match_id: string
          raw: Json
        }
        Update: {
          away_team?: string | null
          fetched_at?: string
          home_team?: string | null
          kickoff?: string | null
          league_id?: string | null
          league_name?: string | null
          match_id?: string
          raw?: Json
        }
        Relationships: []
      }
      predictions: {
        Row: {
          analysis_id: string | null
          away_score: number | null
          away_team: string
          confidence: number
          created_at: string
          engine: string
          expected_value: number | null
          ft_status: string | null
          home_score: number | null
          home_team: string
          id: string
          is_correct: boolean | null
          kickoff: string | null
          league_id: string | null
          league_name: string | null
          market_odds: number | null
          match_id: string | null
          model_probability: number | null
          prediction_type: string
          projected_corners: number | null
          reasons: Json
          recommendation: string | null
          results_updated_at: string | null
          risk_level: string
          selection: string
          stats: Json
          total_corners: number | null
        }
        Insert: {
          analysis_id?: string | null
          away_score?: number | null
          away_team: string
          confidence: number
          created_at?: string
          engine: string
          expected_value?: number | null
          ft_status?: string | null
          home_score?: number | null
          home_team: string
          id?: string
          is_correct?: boolean | null
          kickoff?: string | null
          league_id?: string | null
          league_name?: string | null
          market_odds?: number | null
          match_id?: string | null
          model_probability?: number | null
          prediction_type: string
          projected_corners?: number | null
          reasons?: Json
          recommendation?: string | null
          results_updated_at?: string | null
          risk_level?: string
          selection: string
          stats?: Json
          total_corners?: number | null
        }
        Update: {
          analysis_id?: string | null
          away_score?: number | null
          away_team?: string
          confidence?: number
          created_at?: string
          engine?: string
          expected_value?: number | null
          ft_status?: string | null
          home_score?: number | null
          home_team?: string
          id?: string
          is_correct?: boolean | null
          kickoff?: string | null
          league_id?: string | null
          league_name?: string | null
          market_odds?: number | null
          match_id?: string | null
          model_probability?: number | null
          prediction_type?: string
          projected_corners?: number | null
          reasons?: Json
          recommendation?: string | null
          results_updated_at?: string | null
          risk_level?: string
          selection?: string
          stats?: Json
          total_corners?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "predictions_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
